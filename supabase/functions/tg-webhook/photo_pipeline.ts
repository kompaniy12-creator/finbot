// Photo receipt pipeline (SPEC §6.3):
//   download -> detect mime -> reject HEIC (M9 limitation, v1.1 will add
//   magick-wasm HEIC->JPEG) -> upload to Storage 'receipts' bucket ->
//   signed URL -> Claude Sonnet Vision parse_receipt -> reconcile ±5% ->
//   aggregate items by category -> insert receipt + expenses.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { detectImage, reconcileTotal, sha256Hex } from "../_shared/image.ts";
import { callClaude } from "../_shared/claude.ts";
import { buildParseReceiptPrompt, ParsedReceiptSchema } from "../_shared/prompts/parse_receipt.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { getRate } from "../_shared/currency.ts";
import { log } from "../_shared/log.ts";
import type { ProgressEmitter } from "../_shared/progress.ts";
import { defaultEmbedFn } from "../_shared/embedder.ts";
import { mapWithConcurrency } from "../_shared/concurrency.ts";
import { parseTip } from "../_shared/tip_parse.ts";
import { detectPhotoKind } from "../_shared/intent.ts";

// Parallel embedding for photo items so they also feed the kNN learning loop.
// gte-small in Supabase.ai is fast (~50-200ms per call), so 6 concurrent
// embeddings on a 38-item receipt finish in ~1-2s.
const EMBED_CONCURRENCY = 6;

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
    tx_kind?: "expense" | "income";
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
    tx_kind?: "expense" | "income";
  };

const DEDUP_WINDOW_DAYS = 30;
const EMBED_DIMS = 384;

// Guard against a malformed embedding poisoning the atomic bulk insert. The
// expenses.embedding column is vector(384); anything else (wrong length, NaN)
// would make the whole batch fail. Returns null so the row still saves.
function validEmbedding(e: unknown): number[] | null {
  return Array.isArray(e) && e.length === EMBED_DIMS &&
      e.every((n) => typeof n === "number" && Number.isFinite(n))
    ? e as number[]
    : null;
}

export async function processPhotoMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  fileId: string;
  fileMime?: string;
  telegramMessageId: number;
  /**
   * Free-form caption the user attached to the photo. Used for two things:
   * (1) tip parsing - if the caption contains "чаевые 100 лек" we add an
   *     extra expense row for the tip; (2) Vision context - the rest is
   *     passed to Claude as "user note" so it can pick a better category
   *     for the line items (e.g. "уличные собаки" -> Уличные животные).
   */
  caption?: string;
  progress?: ProgressEmitter;
}): Promise<PhotoOutcome> {
  const p = args.progress;
  const db = tenantDb(args.sb, args.member.tenant_id);
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
  const dupHashRes = await db.from("receipts")
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

  // Decide whether this photo is income or expense based on caption hints.
  // The default is expense (every store receipt). User can override by
  // writing an income hint in the caption: an income category name (with
  // fuzzy match for typos: "Девиденды" ≈ "Дивиденды"), or one of the
  // strong income keywords. Detected before loading categories so we can
  // load the right kind's pool for Vision.
  const captionRawForKind = (args.caption ?? "").trim();
  const photoKind = detectPhotoKind(captionRawForKind);

  // Preload categories so Vision can assign one per item in a single call.
  // This collapses the old N-item Claude-fallback loop into 0 extra calls.
  // Filter by detected kind so Vision can't mix expense and income pools.
  const catRows = await db.from("categories")
    .select("id, name, kind, is_fallback")
    .eq("kind", photoKind)
    .order("is_fallback", { ascending: true })
    .order("name", { ascending: true });
  const categories = (catRows.data ?? []) as Array<
    { id: string; name: string; kind: string; is_fallback: boolean }
  >;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const fallbackCatId = categories.find((c) => c.is_fallback)?.id ?? categories[0]?.id ?? null;
  if (!fallbackCatId) {
    log("error", "photo_no_categories", { kind: photoKind });
    return { kind: "parse_failed" };
  }
  log("info", "photo_kind_detected", { kind: photoKind, caption: captionRawForKind.slice(0, 50) });

  // Call Claude Vision
  const model = Deno.env.get("CLAUDE_MODEL_VISION") ?? "claude-sonnet-4-6";
  const todayIso = todayWarsawIso();
  const { system, tools } = buildParseReceiptPrompt({
    todayWarsaw: todayIso,
    categories,
  });

  // Extract a tip from the caption if present; whatever's left becomes a
  // free-form context note for Vision (helps category assignment).
  const captionRaw = (args.caption ?? "").trim();
  const tip = captionRaw ? parseTip(captionRaw) : null;
  const visionContext = tip ? tip.remainder : captionRaw;
  const userMessage = visionContext
    ? `Parse this receipt. Дополнительный контекст от пользователя (учти его при выборе категорий для позиций): "${visionContext}"`
    : "Parse this receipt.";

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
          { type: "text", text: userMessage },
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

  // Sanity-clamp the receipt date. Vision occasionally misreads the printed
  // year (e.g. "26" interpreted as 2025 instead of 2026) and a single-character
  // OCR error hides the whole receipt from the default Месяц view. Receipts
  // older than 60 days OR dated in the future are almost always a parse error;
  // clamp to today's payment date so the row lands in the current view.
  {
    const visionDate = receipt.receipt_date;
    const t = new Date(todayIso + "T00:00:00Z").getTime();
    const r = new Date(visionDate + "T00:00:00Z").getTime();
    const diffDays = (t - r) / 86_400_000;
    if (diffDays > 60 || diffDays < -1) {
      log("warn", "photo_date_clamped", {
        vision_date: visionDate,
        today: todayIso,
        diff_days: diffDays,
      });
      receipt.receipt_date = todayIso;
    }
  }

  // Reconcile +/- 5%
  const recon = reconcileTotal(receipt.items, receipt.total);
  if (!recon.ok) {
    log("info", "photo_reconciliation_off", {
      sum: recon.sum,
      total: receipt.total,
      delta_ratio: recon.deltaRatio,
    });
  }

  // total->PLN using the same FX rate as line items. getRate now has a
  // nearest-earlier-rate fallback so it doesn't throw on missing ALL/USD rates.
  let receiptRate: number;
  try {
    receiptRate = await getRate(args.sb, receipt.currency, receipt.receipt_date);
  } catch (err) {
    log("error", "photo_rate_unavailable", {
      currency: receipt.currency,
      date: receipt.receipt_date,
      error: (err as Error).message,
    });
    return { kind: "vision_failed", error: `no FX rate for ${receipt.currency}` };
  }
  const totalPln = Math.round(receipt.total * receiptRate * 100) / 100;

  // Layer 2: content-fingerprint duplicate check.
  // Same merchant + receipt_date + total + currency from the same family,
  // not archived. Catches re-photographed-same-receipt cases.
  const dupContentRes = await db.from("receipts")
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
  const recIns = await db.from("receipts").insert({
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
  if (p) await p.update(`💾 Сохраняю ${expected} позиций...`);

  // Same currency+date as the receipt total, so reuse the rate we already loaded.
  const toPlnLocal = (amount: number) => Math.round(amount * receiptRate * 100) / 100;

  // Embed every item name in parallel so the row contributes to future kNN
  // matching (a "молоко" in a receipt should help auto-classify a "молоко"
  // typed by the user later).
  const embedFn = defaultEmbedFn();
  const embeddings = await mapWithConcurrency(
    receipt.items,
    EMBED_CONCURRENCY,
    async (item) => {
      try {
        return await embedFn(item.name_normalized_en);
      } catch (err) {
        log("warn", "photo_embed_failed", {
          name: item.name_normalized_en,
          error: (err as Error).message,
        });
        return null;
      }
    },
  );

  // Build all rows in memory, then ONE atomic bulk INSERT.
  // Vision already assigned category_id to each item; validate against the
  // category list and fall back to the "miscellaneous" category if Vision
  // hallucinated an ID that isn't in the DB. The photo-level kind (detected
  // from caption) is propagated to every row so income screenshots
  // (Дивиденды, Зарплата etc.) land in the income bucket.
  const rows = receipt.items.map((item, i) => {
    const validCat = catById.has(item.category_id) ? item.category_id : fallbackCatId;
    const hallucinated = !catById.has(item.category_id);
    return {
      kind: photoKind,
      name: item.name,
      name_normalized: item.name_normalized_en,
      expense_date: receipt.receipt_date,
      amount: item.amount,
      currency: receipt.currency,
      amount_pln: toPlnLocal(item.amount),
      category_id: validCat,
      family_member_id: args.member.id,
      source: "photo",
      receipt_id: receiptId,
      needs_review: !recon.ok || hallucinated,
      // Only accept a well-formed 384-dim embedding. A malformed one (wrong
      // dimension / non-finite) would otherwise make the WHOLE atomic batch
      // fail, losing every line of the receipt (the "saved 0 of N" bug).
      embedding: validEmbedding(embeddings[i]),
      telegram_message_id: args.telegramMessageId,
      line_index: i,
    };
  });

  // One atomic bulk insert is the fast path. If it fails for any reason (a
  // single bad row would otherwise sink all N), fall back to per-row inserts so
  // a 20-item receipt never silently saves zero. The verify count below is the
  // source of truth either way.
  let insertedHint = 0;
  const bulkIns = await db.from("expenses").insert(rows).select("id");
  if (bulkIns.error) {
    log("error", "photo_bulk_insert_failed", { error: bulkIns.error.message });
    for (const row of rows) {
      const one = await db.from("expenses").insert(row).select("id");
      if (one.error) {
        log("warn", "photo_row_insert_failed", { name: row.name, error: one.error.message });
      } else {
        insertedHint++;
      }
    }
    log("info", "photo_perrow_fallback", { saved: insertedHint, total: rows.length });
  } else {
    insertedHint = bulkIns.data?.length ?? 0;
  }

  // Tip line from caption ("чаевые 100 лек"). Inserted as a separate expense
  // attached to the same receipt, so it shows up under the receipt in the
  // Mini App and counts toward totals. Category: pick the SAME category as
  // the receipt majority (best guess for tips at a restaurant), falling back
  // to fallback if rows is empty for any reason.
  let tipInserted = false;
  if (tip) {
    const tipCurrency = tip.currency ?? receipt.currency;
    const tipRateNeeded = tipCurrency !== receipt.currency;
    let tipRate = receiptRate;
    if (tipRateNeeded) {
      try {
        tipRate = await getRate(args.sb, tipCurrency, receipt.receipt_date);
      } catch {
        tipRate = 1.0;
      }
    }
    // Pick the most frequent category among saved lines (= category of the
    // majority of receipt items). Fallback if nothing was inserted.
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
    const topCat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallbackCatId;
    const tipPln = Math.round(tip.amount * tipRate * 100) / 100;
    const tipIns = await db.from("expenses").insert({
      kind: photoKind, // inherits photo's overall kind (expense in 99% of cases)
      name: "Чаевые",
      name_normalized: "tip gratuity",
      expense_date: receipt.receipt_date,
      amount: tip.amount,
      currency: tipCurrency,
      amount_pln: tipPln,
      category_id: topCat,
      family_member_id: args.member.id,
      source: "photo",
      receipt_id: receiptId,
      needs_review: false,
      telegram_message_id: args.telegramMessageId,
      line_index: rows.length, // append after Vision lines
    });
    if (tipIns.error) {
      log("warn", "photo_tip_insert_failed", { error: tipIns.error.message });
    } else {
      tipInserted = true;
      // Update receipt total to include the tip.
      const newTotal = Math.round(
        (Number(receipt.total) + tip.amount * (
              tipCurrency === receipt.currency ? 1 : tipRate / receiptRate
            )) * 100,
      ) / 100;
      const newTotalPln = Math.round((totalPln + tipPln) * 100) / 100;
      await db.from("receipts").update({
        total: newTotal,
        total_pln: newTotalPln,
      }).eq("id", receiptId);
    }
  }

  // Mandatory verification: trust nothing, count what's actually in the DB.
  const verifyRes = await db.from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("receipt_id", receiptId)
    .eq("archived", false);
  const verifiedCount = verifyRes.count ?? insertedHint;

  const summary: ReceiptLineSummary[] = rows.map((r) => ({
    name: r.name,
    amount: r.amount,
    currency: receipt.currency,
    category_name: catById.get(r.category_id)?.name ?? "?",
  }));
  if (tipInserted && tip) {
    summary.push({
      name: "Чаевые",
      amount: tip.amount,
      currency: tip.currency ?? receipt.currency,
      category_name: catById.get(
        [...new Map(rows.map((r) => [r.category_id, true])).keys()][0] ?? fallbackCatId,
      )?.name ?? "?",
    });
  }
  // expected count = OCR items + (tip if user added one). Verification
  // compares against the receipt's row count, which now also includes the tip.
  const expectedWithTip = expected + (tipInserted ? 1 : 0);

  if (verifiedCount < expectedWithTip) {
    log("warn", "photo_partial_save", {
      receipt_id: receiptId,
      expected: expectedWithTip,
      verified: verifiedCount,
    });
    return {
      kind: "partial",
      receipt_id: receiptId,
      expense_count: verifiedCount,
      expected_count: expectedWithTip,
      merchant: receipt.merchant ?? null,
      total: receipt.total,
      currency: receipt.currency,
      items: summary,
      tx_kind: photoKind,
    };
  }

  return {
    kind: "ok",
    receipt_id: receiptId,
    expense_count: verifiedCount,
    expected_count: expectedWithTip,
    verified: true,
    reconciled: recon.ok,
    merchant: receipt.merchant ?? null,
    total: receipt.total,
    currency: receipt.currency,
    items: summary,
    tx_kind: photoKind,
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
