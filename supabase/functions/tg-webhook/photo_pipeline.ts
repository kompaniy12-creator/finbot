// Photo receipt pipeline (SPEC §6.3):
//   download -> detect mime -> reject HEIC (M9 limitation, v1.1 will add
//   magick-wasm HEIC->JPEG) -> upload to Storage 'receipts' bucket ->
//   signed URL -> Claude Sonnet Vision parse_receipt -> reconcile ±5% ->
//   aggregate items by category -> insert receipt + expenses.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { detectImage, reconcileTotal } from "../_shared/image.ts";
import { callClaude } from "../_shared/claude.ts";
import { buildParseReceiptPrompt, ParsedReceiptSchema } from "../_shared/prompts/parse_receipt.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { categorize } from "../_shared/categorizer.ts";
import { defaultEmbedFn } from "../_shared/embedder.ts";
import { buildClaudeFallback } from "../_shared/claude_fallback.ts";
import { toPln } from "../_shared/currency.ts";
import { log } from "../_shared/log.ts";

const SIGNED_URL_TTL_SEC = 300;
const STORAGE_BUCKET = "receipts";

export type PhotoOutcome =
  | { kind: "heic_unsupported" }
  | { kind: "unsupported_mime"; mime: string }
  | { kind: "download_failed" }
  | { kind: "vision_failed"; error: string }
  | { kind: "parse_failed" }
  | { kind: "ok"; receipt_id: string; expense_count: number; reconciled: boolean };

export async function processPhotoMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  fileId: string;
  fileMime?: string;
  telegramMessageId: number;
}): Promise<PhotoOutcome> {
  const buf = await downloadTelegramFile(args.fileId);
  if (!buf) return { kind: "download_failed" };

  const detected = detectImage(buf, args.fileMime);
  if (detected.isHeic) {
    log("info", "photo_heic_rejected", { size: detected.size });
    return { kind: "heic_unsupported" };
  }
  if (!detected.accepted) {
    return { kind: "unsupported_mime", mime: detected.mime };
  }

  // Upload to Storage
  const stamp = todayWarsawIso();
  const ext = detected.mime === "image/png" ? "png" : "jpg";
  const path = `${args.member.id}/${stamp}/${crypto.randomUUID()}.${ext}`;
  const upload = await args.sb.storage.from(STORAGE_BUCKET).upload(path, buf, {
    contentType: detected.mime,
    upsert: false,
  });
  if (upload.error) {
    log("warn", "photo_upload_failed", { error: upload.error.message });
    return { kind: "download_failed" };
  }
  const signed = await args.sb.storage.from(STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (signed.error || !signed.data?.signedUrl) {
    log("warn", "photo_sign_failed", { error: signed.error?.message });
    return { kind: "download_failed" };
  }

  // Call Claude Vision
  const model = Deno.env.get("CLAUDE_MODEL_VISION") ?? "claude-sonnet-4-6";
  const todayIso = todayWarsawIso();
  const { system, tools } = buildParseReceiptPrompt({ todayWarsaw: todayIso });

  let resp;
  try {
    resp = await callClaude({
      sb: args.sb,
      familyMemberId: args.member.id,
      model,
      system,
      tools,
      maxTokens: 4096,
      toolChoice: { type: "tool", name: "record_receipt" },
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              url: signed.data.signedUrl,
            },
          },
          { type: "text", text: "Parse this receipt." },
        ],
      }],
    });
  } catch (err) {
    return { kind: "vision_failed", error: (err as Error).message };
  }

  const toolUse = resp.response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.name !== "record_receipt") return { kind: "parse_failed" };

  const parsed = ParsedReceiptSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    log("warn", "photo_parse_failed", { issues: parsed.error.issues.slice(0, 3) });
    return { kind: "parse_failed" };
  }
  const receipt = parsed.data;

  // Reconcile +/- 5%
  const recon = reconcileTotal(receipt.items, receipt.total);
  if (!recon.ok) {
    log("info", "photo_reconciliation_off", {
      sum: recon.sum,
      total: receipt.total,
      delta_ratio: recon.deltaRatio,
    });
  }

  const totalPln = await toPln(args.sb, receipt.total, receipt.currency, receipt.receipt_date);

  // Insert receipt
  const recIns = await args.sb.from("receipts").insert({
    merchant: receipt.merchant,
    receipt_date: receipt.receipt_date,
    currency: receipt.currency,
    total: receipt.total,
    total_pln: totalPln,
    photo_path: path,
    items: receipt.items,
    family_member_id: args.member.id,
    telegram_message_id: args.telegramMessageId,
  }).select("id").maybeSingle();
  if (recIns.error || !recIns.data) {
    return { kind: "vision_failed", error: recIns.error?.message ?? "no data" };
  }
  const receiptId = (recIns.data as { id: string }).id;

  // For each item: categorize, currency convert (same date as receipt), insert
  const embedFn = defaultEmbedFn();
  const fallback = buildClaudeFallback(args.sb, args.member.id);
  let count = 0;
  for (let i = 0; i < receipt.items.length; i++) {
    const item = receipt.items[i]!;
    const cat = await categorize(
      { sb: args.sb, embedFn, fallback },
      {
        name: item.name,
        nameNormalizedEn: item.name_normalized_en,
        familyMemberId: args.member.id,
      },
    );
    const amountPln = await toPln(args.sb, item.amount, receipt.currency, receipt.receipt_date);
    const exp = await args.sb.from("expenses").insert({
      name: item.name,
      name_normalized: item.name_normalized_en,
      expense_date: receipt.receipt_date,
      amount: item.amount,
      currency: receipt.currency,
      amount_pln: amountPln,
      category_id: cat.categoryId,
      family_member_id: args.member.id,
      source: "photo",
      receipt_id: receiptId,
      needs_review: !recon.ok,
      embedding: cat.embedding,
      telegram_message_id: args.telegramMessageId,
      line_index: i,
    });
    if (!exp.error) count++;
  }

  return { kind: "ok", receipt_id: receiptId, expense_count: count, reconciled: recon.ok };
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
