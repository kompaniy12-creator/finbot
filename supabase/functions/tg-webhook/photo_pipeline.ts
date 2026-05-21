// Photo receipt pipeline (SPEC §6.3):
//   download -> detect mime -> reject HEIC (M9 limitation, v1.1 will add
//   magick-wasm HEIC->JPEG) -> upload to Storage 'receipts' bucket ->
//   signed URL -> Claude Sonnet Vision parse_receipt -> reconcile ±5% ->
//   aggregate items by category -> insert receipt + expenses.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { detectImage, reconcileTotal, sha256Hex } from "../_shared/image.ts";
import { callClaude } from "../_shared/claude.ts";
import { buildParseReceiptPrompt, ParsedReceiptSchema } from "../_shared/prompts/parse_receipt.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { categorize } from "../_shared/categorizer.ts";
import { defaultEmbedFn } from "../_shared/embedder.ts";
import { buildClaudeFallback } from "../_shared/claude_fallback.ts";
import { getRate, toPln } from "../_shared/currency.ts";
import { log } from "../_shared/log.ts";
import type { ProgressEmitter } from "../_shared/progress.ts";
import { mapWithConcurrency } from "../_shared/concurrency.ts";

// Bounded parallelism for per-item categorization. Higher = faster but more
// concurrent Claude-fallback requests. 6 keeps us under common rate limits
// while shrinking a 38-item receipt from ~60s sequential to ~10s.
const ITEM_CONCURRENCY = 6;

const SIGNED_URL_TTL_SEC = 300;
const STORAGE_BUCKET = "receipts";

export interface ReceiptLineSummary {
  name: string;
  amount: number;
  currency: string;
  category_name: string;
}

export type PhotoOutcome =
  | { kind: "heic_unsupported" }
  | { kind: "unsupported_mime"; mime: string }
  | { kind: "download_failed" }
  | { kind: "vision_failed"; error: string }
  | { kind: "parse_failed" }
  | {
    kind: "duplicate";
    reason: "image_hash" | "content_match";
    existing_receipt_id: string;
    existing_merchant: string | null;
    existing_total: number;
    existing_currency: string;
    existing_date: string;
  }
  | {
    kind: "ok";
    receipt_id: string;
    expense_count: number;
    expected_count: number;
    verified: boolean;
    reconciled: boolean;
    merchant: string | null;
    total: number;
    currency: string;
    items: ReceiptLineSummary[];
  }
  | {
    kind: "partial";
    receipt_id: string;
    expense_count: number;
    expected_count: number;
    merchant: string | null;
    total: number;
    currency: string;
    items: ReceiptLineSummary[];
  };

const DEDUP_WINDOW_DAYS = 30;

export async function processPhotoMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  fileId: string;
  fileMime?: string;
  telegramMessageId: number;
  progress?: ProgressEmitter;
}): Promise<PhotoOutcome> {
  const p = args.progress;
  if (p) await p.update("📥 Скачиваю фото...");
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

  // Layer 1: byte-identical duplicate check via SHA-256 of the bytes.
  const photoHash = await sha256Hex(buf);
  const sinceIso = new Date(Date.now() - DEDUP_WINDOW_DAYS * 86_400_000).toISOString();
  const dupHashRes = await args.sb.from("receipts")
    .select("id, merchant, total, currency, receipt_date")
    .eq("family_member_id", args.member.id)
    .eq("archived", false)
    .eq("photo_sha256", photoHash)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle();
  if (dupHashRes.data) {
    const ex = dupHashRes.data as {
      id: string;
      merchant: string | null;
      total: number;
      currency: string;
      receipt_date: string;
    };
    log("info", "photo_duplicate_hash", { existing: ex.id });
    return {
      kind: "duplicate",
      reason: "image_hash",
      existing_receipt_id: ex.id,
      existing_merchant: ex.merchant,
      existing_total: Number(ex.total),
      existing_currency: ex.currency,
      existing_date: ex.receipt_date,
    };
  }

  if (p) await p.update("📤 Загружаю в хранилище...");

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

  if (p) await p.update("👁 Распознаю чек через Claude Vision...");

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

  // Layer 2: content-fingerprint duplicate check.
  // Same merchant + receipt_date + total + currency from the same family,
  // not archived. Catches re-photographed-same-receipt cases.
  const dupContentRes = await args.sb.from("receipts")
    .select("id, merchant, total, currency, receipt_date")
    .eq("family_member_id", args.member.id)
    .eq("archived", false)
    .eq("merchant", receipt.merchant)
    .eq("receipt_date", receipt.receipt_date)
    .eq("currency", receipt.currency)
    .eq("total", receipt.total)
    .limit(1)
    .maybeSingle();
  if (dupContentRes.data) {
    const ex = dupContentRes.data as {
      id: string;
      merchant: string | null;
      total: number;
      currency: string;
      receipt_date: string;
    };
    log("info", "photo_duplicate_content", { existing: ex.id });
    return {
      kind: "duplicate",
      reason: "content_match",
      existing_receipt_id: ex.id,
      existing_merchant: ex.merchant,
      existing_total: Number(ex.total),
      existing_currency: ex.currency,
      existing_date: ex.receipt_date,
    };
  }

  // Insert receipt
  const recIns = await args.sb.from("receipts").insert({
    merchant: receipt.merchant,
    receipt_date: receipt.receipt_date,
    currency: receipt.currency,
    total: receipt.total,
    total_pln: totalPln,
    photo_path: path,
    photo_sha256: photoHash,
    items: receipt.items,
    family_member_id: args.member.id,
    telegram_message_id: args.telegramMessageId,
  }).select("id").maybeSingle();
  if (recIns.error || !recIns.data) {
    return { kind: "vision_failed", error: recIns.error?.message ?? "no data" };
  }
  const receiptId = (recIns.data as { id: string }).id;

  const expected = receipt.items.length;
  if (p) await p.update(`💾 Распознаю ${expected} позиций (категории)...`);

  // Preload category names for the summary message.
  const catRows = await args.sb.from("categories").select("id, name");
  const catNameById = new Map<string, string>();
  for (const c of (catRows.data ?? []) as Array<{ id: string; name: string }>) {
    catNameById.set(c.id, c.name);
  }

  // Receipt items all share the same date+currency, so one FX rate lookup
  // beats 38 sequential toPln calls.
  let rate: number;
  try {
    rate = await getRate(args.sb, receipt.currency, receipt.receipt_date);
  } catch (err) {
    log("warn", "photo_rate_fallback", { error: (err as Error).message });
    rate = 1.0; // graceful fallback; needs_review will flag for follow-up
  }
  const toPlnLocal = (amount: number) => Math.round(amount * rate * 100) / 100;

  // Bounded parallel categorization (max ITEM_CONCURRENCY at once).
  const embedFn = defaultEmbedFn();
  const fallback = buildClaudeFallback(args.sb, args.member.id);
  const prepared = await mapWithConcurrency(
    receipt.items,
    ITEM_CONCURRENCY,
    async (item, _i) =>
      await categorize(
        { sb: args.sb, embedFn, fallback },
        {
          name: item.name,
          nameNormalizedEn: item.name_normalized_en,
          familyMemberId: args.member.id,
        },
      ),
  );

  if (p) await p.update(`💾 Сохраняю ${expected} позиций...`);

  // Build all rows in memory, then ONE atomic bulk INSERT.
  const rows = receipt.items.map((item, i) => ({
    name: item.name,
    name_normalized: item.name_normalized_en,
    expense_date: receipt.receipt_date,
    amount: item.amount,
    currency: receipt.currency,
    amount_pln: toPlnLocal(item.amount),
    category_id: prepared[i]!.categoryId,
    family_member_id: args.member.id,
    source: "photo",
    receipt_id: receiptId,
    needs_review: !recon.ok,
    embedding: prepared[i]!.embedding,
    telegram_message_id: args.telegramMessageId,
    line_index: i,
  }));

  const bulkIns = await args.sb.from("expenses").insert(rows).select("id");
  if (bulkIns.error) {
    log("error", "photo_bulk_insert_failed", { error: bulkIns.error.message });
  }
  const insertedHint = bulkIns.data?.length ?? 0;

  // Mandatory verification: trust nothing, count what's actually in the DB.
  const verifyRes = await args.sb.from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("receipt_id", receiptId)
    .eq("archived", false);
  const verifiedCount = verifyRes.count ?? insertedHint;

  const summary: ReceiptLineSummary[] = receipt.items.map((item, i) => ({
    name: item.name,
    amount: item.amount,
    currency: receipt.currency,
    category_name: catNameById.get(prepared[i]!.categoryId) ?? "?",
  }));

  if (verifiedCount < expected) {
    log("warn", "photo_partial_save", {
      receipt_id: receiptId,
      expected,
      verified: verifiedCount,
    });
    return {
      kind: "partial",
      receipt_id: receiptId,
      expense_count: verifiedCount,
      expected_count: expected,
      merchant: receipt.merchant ?? null,
      total: receipt.total,
      currency: receipt.currency,
      items: summary,
    };
  }

  return {
    kind: "ok",
    receipt_id: receiptId,
    expense_count: verifiedCount,
    expected_count: expected,
    verified: true,
    reconciled: recon.ok,
    merchant: receipt.merchant ?? null,
    total: receipt.total,
    currency: receipt.currency,
    items: summary,
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
