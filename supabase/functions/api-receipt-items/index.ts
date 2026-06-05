// GET /api-receipt-items?id=<receipt_uuid>
// Returns all expense lines for a specific receipt (the auth'd user must own
// the receipt, or be admin).

import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json(req, { error: "id (uuid) required" }, 400);
  }

  const recRes = await db.from("receipts")
    .select("id, merchant, total, currency, total_pln, receipt_date, family_member_id, items")
    .eq("id", id)
    .maybeSingle();
  if (recRes.error) return json(req, { error: recRes.error.message }, 500);
  const receipt = recRes.data as {
    id: string;
    merchant: string | null;
    total: number;
    currency: string;
    total_pln: number;
    receipt_date: string;
    family_member_id: string;
    items: unknown;
  } | null;
  if (!receipt) return json(req, { error: "not_found" }, 404);
  // Family-wide visibility: anyone in the family can open any receipt.
  void me;

  const lineRes = await db.from("expenses")
    .select(
      "id, kind, name, amount, currency, amount_pln, category_id, line_index, needs_review, needs_confirmation, created_at",
    )
    .eq("receipt_id", id)
    .eq("archived", false)
    .order("line_index", { ascending: true });
  if (lineRes.error) return json(req, { error: lineRes.error.message }, 500);

  const eurRates = await loadEurRates(sb, [receipt.receipt_date]);
  const lines = (lineRes.data ?? []) as Array<{
    id: string;
    kind: "expense" | "income";
    name: string;
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    line_index: number;
    needs_review: boolean;
    needs_confirmation: boolean;
    created_at: string;
  }>;
  const items = lines.map((l) => ({
    ...l,
    amount_eur: plnToEur(Number(l.amount_pln), receipt.receipt_date, eurRates) ?? 0,
  }));

  // OCR-detected item count for the verification badge in the UI.
  const ocrItems = Array.isArray(receipt.items) ? (receipt.items as unknown[]).length : null;

  return json(req, {
    receipt: {
      id: receipt.id,
      merchant: receipt.merchant,
      total: Number(receipt.total),
      currency: receipt.currency,
      total_pln: Number(receipt.total_pln),
      total_eur: plnToEur(Number(receipt.total_pln), receipt.receipt_date, eurRates) ?? 0,
      receipt_date: receipt.receipt_date,
      ocr_item_count: ocrItems,
      saved_item_count: items.length,
      verified: ocrItems !== null ? items.length === ocrItems : null,
    },
    items,
  });
});
