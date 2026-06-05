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
import { categorize } from "../_shared/categorizer.ts";
import { defaultEmbedFn } from "../_shared/embedder.ts";
import { buildClaudeFallback } from "../_shared/claude_fallback.ts";
import { log } from "../_shared/log.ts";

export interface ExtendedReconcileSummary extends ReconcileSummary {
  /** Auto-created from bank lines that had no matching receipt/expense. */
  auto_created: number;
}

export type BankPipelineOutcome =
  | { kind: "no_file"; statement_id: string }
  | { kind: "download_failed"; statement_id: string }
  | { kind: "parse_failed"; statement_id: string; error: string }
  | {
    kind: "ok";
    statement_id: string;
    source: string;
    total_lines: number;
    summary: ExtendedReconcileSummary;
  };

export async function processBankStatement(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  statementId: string;
  /**
   * 'pdf' for documents/file_path PDFs, 'image' for bank-app screenshots
   * (Telegram photo or image-MIME document). Affects the Claude content
   * block - documents go via {type: document}, images via {type: image}.
   */
  mediaType?: "pdf" | "image";
  mimeType?: string; // for image: image/png, image/jpeg, etc.
}): Promise<BankPipelineOutcome> {
  const { sb, member, statementId, mediaType = "pdf", mimeType } = args;

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

  // 2. Download file bytes.
  const fileBytes = await downloadTelegramFile(fileId);
  if (!fileBytes) {
    await sb.from("bank_statements").update({
      status: "failed",
      error: "telegram_download_failed",
    }).eq("id", statementId);
    return { kind: "download_failed", statement_id: statementId };
  }

  // 3. Claude Sonnet vision/document parse. Same tool schema works for both
  // PDF documents and screenshot images - the difference is only the content
  // block envelope.
  const base64 = bytesToBase64(fileBytes);
  const { system, tools } = buildBankStatementPrompt();
  const model = Deno.env.get("CLAUDE_MODEL_VISION") ?? "claude-sonnet-4-6";
  // A full-month statement can hold 100+ lines; at ~150 output tokens per line
  // the old 8192 cap truncated the tool call mid-JSON, so `lines` never arrived
  // and zod failed with "lines: Required". We only pay for tokens actually
  // generated, so a generous cap is safe. Override via BANK_PARSE_MAX_TOKENS.
  const maxTokens = Number(Deno.env.get("BANK_PARSE_MAX_TOKENS")) || 16000;

  const contentBlock = mediaType === "image"
    ? {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: (mimeType ?? "image/jpeg") as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: base64,
      },
    }
    : {
      type: "document" as const,
      source: {
        type: "base64" as const,
        media_type: "application/pdf" as const,
        data: base64,
      },
    };

  const promptText = mediaType === "image"
    ? "Parse this BANK APP SCREENSHOT (mBank mobile app history view). Each visible row is one transaction. Read the merchant name on the left, the amount on the right (e.g. '-29,81 PLN' or '+650,50 PLN'). Sign of the amount determines kind: '-' = expense, no minus = income. The category text below merchant name (e.g. 'Żywność i chemia domowa') is mBank's auto-category - ignore it, just capture the transaction. Date: each row's date is typically shown above as a separator like '3 czerwca' (3 June). Use that grouping date. Method: card if it has the card icon (rectangle/credit card), transfer for arrow icons. Emit one tool call covering every visible row."
    : "Parse this bank statement. Emit one tool call covering every transaction.";

  let resp;
  try {
    resp = await callClaude({
      sb,
      familyMemberId: member.id,
      model,
      system,
      tools,
      maxTokens,
      toolChoice: { type: "tool", name: "parse_bank_statement" },
      messages: [{
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: promptText },
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

  // Truncation guard: if Claude hit the output cap, the tool-call JSON is cut
  // off (typically before `lines`), which would otherwise surface as a cryptic
  // zod "lines: Required". Catch it here and tell the user something actionable.
  if (resp.response.stop_reason === "max_tokens") {
    log("warn", "bank_parse_truncated", { statement_id: statementId, maxTokens });
    await sb.from("bank_statements").update({
      status: "failed",
      error: "truncated_max_tokens",
    }).eq("id", statementId);
    return { kind: "parse_failed", statement_id: statementId, error: "truncated" };
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

  // 6. Auto-create expenses for lines that had no candidate. Each gets
  // run through the same categorizer the text-pipeline uses, so the
  // resulting row has a sensible category and contributes to the kNN
  // training set next time. This is what the user wants: 'не нашёл в
  // базе' should become 'создал N новых' instead of silent triage.
  const autoCreated = await autoCreateUnmatched(sb, member, statementId);

  await sb.from("bank_statements").update({
    matched_lines: summary.matched,
    added_lines: autoCreated,
  }).eq("id", statementId);

  const ext: ExtendedReconcileSummary = { ...summary, auto_created: autoCreated };
  // After auto-create, no_candidate effectively went to zero - report
  // the original count for transparency, but reduce by what we added.
  ext.no_candidate = Math.max(0, summary.no_candidate - autoCreated);
  return {
    kind: "ok",
    statement_id: statementId,
    source: out.source,
    total_lines: rows.length,
    summary: ext,
  };
}

interface PendingLine {
  id: string;
  family_member_id: string;
  posted_date: string;
  amount: number;
  currency: "PLN" | "EUR" | "ALL" | "USD";
  description: string;
  method: "card" | "cash" | "transfer";
  kind: "expense" | "income";
}

async function autoCreateUnmatched(
  sb: SupabaseClient,
  member: FamilyMember,
  statementId: string,
): Promise<number> {
  // After reconcile, lines that found no candidate stay status='pending'.
  // Internal-transfer lines are already 'skipped'. Auto-create every
  // remaining pending line as a fresh expense/income row.
  const res = await sb.from("bank_statement_lines")
    .select(
      "id, family_member_id, posted_date, amount, currency, description, method, kind",
    )
    .eq("statement_id", statementId)
    .eq("status", "pending");
  const lines = (res.data ?? []) as PendingLine[];
  if (lines.length === 0) return 0;

  const embedFn = defaultEmbedFn();
  const fallback = buildClaudeFallback(sb, member.id);

  let created = 0;
  for (const line of lines) {
    try {
      // Use the bank's description as both raw name and embedder input.
      // gte-small handles cross-language reasonably, so 'Jumbo' /
      // 'BIG EMIGRANTI' / 'ROZL. OPROC.' all embed coherently.
      const rawName = line.description?.trim() || "Bank transaction";
      const normalized = rawName.toLowerCase();

      const cat = await categorize(
        { sb, embedFn, fallback },
        {
          name: rawName,
          nameNormalizedEn: normalized,
          familyMemberId: line.family_member_id,
          kind: line.kind,
        },
      );

      const amount = Number(line.amount);
      const amountPln = line.currency === "PLN" ? amount : amount;

      const ins = await sb.from("expenses").insert({
        kind: line.kind,
        name: rawName,
        name_normalized: normalized,
        expense_date: line.posted_date,
        amount,
        currency: line.currency,
        amount_pln: amountPln,
        category_id: cat.categoryId,
        family_member_id: line.family_member_id,
        source: "text",
        payment_method: line.method,
        description: `Авто-создано из выписки`,
        confidence: cat.confidence === "high" ? 1.0 : cat.confidence === "medium" ? 0.85 : 0.5,
        // Confident classifications go straight to the books; the rest
        // are flagged for review so the user can correct them in the
        // Mini App and feed the kNN.
        needs_confirmation: cat.confidence !== "high",
        embedding: cat.embedding,
        reconciled_at: new Date().toISOString(),
        bank_statement_line_id: line.id,
      }).select("id").maybeSingle();

      if (ins.error || !ins.data) {
        log("warn", "auto_create_insert_failed", {
          line_id: line.id,
          error: ins.error?.message,
        });
        continue;
      }
      const expenseId = (ins.data as { id: string }).id;
      await sb.from("bank_statement_lines").update({
        status: "added",
        matched_expense_id: expenseId,
      }).eq("id", line.id);
      created++;
    } catch (err) {
      log("warn", "auto_create_failed", {
        line_id: line.id,
        error: (err as Error).message,
      });
    }
  }
  log("info", "bank_auto_create_done", { statement_id: statementId, created });
  return created;
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
