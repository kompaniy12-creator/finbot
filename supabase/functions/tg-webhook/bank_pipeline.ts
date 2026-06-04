// Bank statement pipeline: PDF in, reconciled DB out.
//
// Flow:
//   1. Resolve the bank_statements row (already created by webhook intake).
//   2. Download the PDF bytes from Telegram (via the file_id stashed in raw_text).
//   3. Send the PDF base64 to Claude Sonnet with parse_bank_statement tool.
//   4. Insert one bank_statement_lines row per parsed transaction.
//   5. Run reconcile to auto-match against existing receipts / solo expenses.
//   6. Return summary for the bot to post back to the user.
//
// Internal transfers and bank fees are written but their lines are flagged
// is_internal_transfer=true upstream, so reconcile skips them.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { callClaude } from "../_shared/claude.ts";
import {
  buildBankStatementPrompt,
  ParseBankStatementOutputSchema,
} from "../_shared/prompts/parse_bank_statement.ts";
import { reconcileStatement, type ReconcileSummary } from "../_shared/reconcile.ts";
import { log } from "../_shared/log.ts";

export type BankPipelineOutcome =
  | { kind: "no_file"; statement_id: string }
  | { kind: "download_failed"; statement_id: string }
  | { kind: "parse_failed"; statement_id: string; error: string }
  | {
    kind: "ok";
    statement_id: string;
    source: string;
    total_lines: number;
    summary: ReconcileSummary;
  };

export async function processBankStatement(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  statementId: string;
}): Promise<BankPipelineOutcome> {
  const { sb, member, statementId } = args;

  // 1. Load statement row + extract Telegram file_id stashed in raw_text.
  const stmtRes = await sb
    .from("bank_statements")
    .select("id, raw_text, filename")
    .eq("id", statementId)
    .maybeSingle();
  if (stmtRes.error || !stmtRes.data) {
    return { kind: "no_file", statement_id: statementId };
  }
  const stmt = stmtRes.data as { id: string; raw_text: string | null; filename: string | null };
  const tgFileIdMatch = (stmt.raw_text ?? "").match(/TG_FILE_ID:([A-Za-z0-9_-]+)/);
  const fileId = tgFileIdMatch?.[1];
  if (!fileId) {
    return { kind: "no_file", statement_id: statementId };
  }

  // 2. Download PDF.
  const pdfBytes = await downloadTelegramFile(fileId);
  if (!pdfBytes) {
    await sb.from("bank_statements").update({
      status: "failed",
      error: "telegram_download_failed",
    }).eq("id", statementId);
    return { kind: "download_failed", statement_id: statementId };
  }

  // 3. Claude Sonnet (vision/document) parse.
  const base64 = bytesToBase64(pdfBytes);
  const { system, tools } = buildBankStatementPrompt();
  const model = Deno.env.get("CLAUDE_MODEL_VISION") ?? "claude-sonnet-4-6";

  let resp;
  try {
    resp = await callClaude({
      sb,
      familyMemberId: member.id,
      model,
      system,
      tools,
      maxTokens: 8192,
      toolChoice: { type: "tool", name: "parse_bank_statement" },
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          {
            type: "text",
            text: "Parse this bank statement. Emit one tool call covering every transaction.",
          },
        ],
      }],
    });
  } catch (err) {
    log("error", "bank_parse_claude_failed", { error: (err as Error).message });
    await sb.from("bank_statements").update({
      status: "failed",
      error: (err as Error).message.slice(0, 500),
    }).eq("id", statementId);
    return { kind: "parse_failed", statement_id: statementId, error: (err as Error).message };
  }

  const toolUse = resp.response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.name !== "parse_bank_statement") {
    await sb.from("bank_statements").update({
      status: "failed",
      error: "no_tool_use_block",
    }).eq("id", statementId);
    return { kind: "parse_failed", statement_id: statementId, error: "no_tool_use_block" };
  }
  const parsed = ParseBankStatementOutputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    await sb.from("bank_statements").update({
      status: "failed",
      error: JSON.stringify(parsed.error.issues).slice(0, 500),
    }).eq("id", statementId);
    return { kind: "parse_failed", statement_id: statementId, error: "zod_parse_failed" };
  }

  const out = parsed.data;
  log("info", "bank_parse_ok", {
    statement_id: statementId,
    source: out.source,
    line_count: out.lines.length,
  });

  // 4. Insert bank_statement_lines.
  const rows = out.lines.map((l) => ({
    statement_id: statementId,
    family_member_id: member.id,
    posted_date: l.posted_date,
    amount: l.amount,
    currency: l.currency,
    description: l.description,
    method: l.method === "fee" ? "transfer" : l.method, // schema enum doesn't include 'fee' yet - collapse
    kind: l.kind,
    raw_row: l,
    // Skip internal transfers up front - reconcile would skip them anyway,
    // but writing them as 'skipped' keeps the audit cleaner.
    status: l.is_internal_transfer ? "skipped" : "pending",
  }));

  // Wipe any previous lines (re-parse case) then insert fresh.
  await sb.from("bank_statement_lines").delete().eq("statement_id", statementId);
  if (rows.length > 0) {
    const ins = await sb.from("bank_statement_lines").insert(rows);
    if (ins.error) {
      log("error", "bank_lines_insert_failed", { error: ins.error.message });
    }
  }
  await sb.from("bank_statements").update({
    status: "parsed",
    source: out.source,
    period_start: out.period_start ?? null,
    period_end: out.period_end ?? null,
    total_lines: rows.length,
    raw_text: null, // wipe file-id placeholder
  }).eq("id", statementId);

  // 5. Reconcile.
  const summary = await reconcileStatement(sb, statementId);

  await sb.from("bank_statements").update({
    matched_lines: summary.matched,
    added_lines: summary.skipped, // intentional: 'skipped' here means we ignored, not 'added'
  }).eq("id", statementId);

  return {
    kind: "ok",
    statement_id: statementId,
    source: out.source,
    total_lines: rows.length,
    summary,
  };
}

async function downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  const getFileResp = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
  );
  if (!getFileResp.ok) return null;
  const j = await getFileResp.json() as { result?: { file_path: string } };
  if (!j.result?.file_path) return null;
  const fileResp = await fetch(
    `https://api.telegram.org/file/bot${token}/${j.result.file_path}`,
  );
  if (!fileResp.ok) return null;
  return new Uint8Array(await fileResp.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid blowing the stack on multi-MB PDFs by chunking.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
