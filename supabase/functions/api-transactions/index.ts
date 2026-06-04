// GET /api-transactions?limit=N&offset=M&search=...
// Returns a unified feed of "transactions" where each item is either:
//   - kind="receipt": one row per receipt (merchant + total + item_count)
//   - kind="expense": standalone expense (no receipt_id)
// Sorted by created_at desc. Search matches receipt.merchant or expense.name.

import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { resolveDateWindow } from "../_shared/period.ts";

interface FeedItem {
  // `kind` is the FEED row type (receipt vs solo expense), unchanged for
  // backwards-compat. `tx_kind` is the cashflow direction (expense vs
  // income) added when we introduced income tracking. Receipts are always
  // tx_kind='expense' (you don't photograph a paycheck).
  kind: "receipt" | "expense";
  tx_kind: "expense" | "income";
  id: string;
  title: string;
  amount: number;
  currency: string;
  amount_pln: number;
  amount_eur: number;
  expense_date: string;
  family_member_id: string;
  category_id: string | null;
  needs_review: boolean;
  needs_confirmation: boolean;
  receipt_id: string | null;
  item_count: number;
  created_at: string;
  // Payment + reconciliation (added with bank-statement import).
  payment_method: "card" | "cash" | "transfer" | "unknown";
  reconciled: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  const search = (url.searchParams.get("search") ?? "").trim();
  // Always apply the period window so the feed matches the KPIs. Any of
  // from/to, month=YYYY-MM, or period=day|week|month selects a window;
  // with no params the helper defaults to the current calendar month.
  const today = todayWarsawIso();
  const win = resolveDateWindow(url, today);

  // Optional filters (each independently applied; empty/invalid -> ignored).
  const UUID = /^[0-9a-f-]{36}$/i;
  const filterCategoryId = url.searchParams.get("category_id");
  const filterMemberId = url.searchParams.get("family_member_id");
  const filterSource = (url.searchParams.get("source") ?? "").toLowerCase();
  const validSource = filterSource === "photo" || filterSource === "voice" ||
      filterSource === "text"
    ? filterSource
    : null;
  const validCategory = filterCategoryId && UUID.test(filterCategoryId) ? filterCategoryId : null;
  const validMember = filterMemberId && UUID.test(filterMemberId) ? filterMemberId : null;

  // Build SQL via Management API isn't available from Edge; use supabase-js with
  // two queries + merge in JS. This keeps the endpoint stateless.

  // Family-wide feed: every member sees every member's transactions.
  void me;
  // 1. Receipts (one row per receipt) with line counts.
  // NOTE: receipts don't have a category_id at the receipt level (categories
  // live on line items), so a category filter HIDES receipts entirely. Same
  // for a text/voice source filter (receipts are always source=photo).
  const skipReceipts = validCategory !== null ||
    (validSource !== null && validSource !== "photo");
  let receipts: Array<{
    id: string;
    merchant: string | null;
    total: number;
    currency: string;
    total_pln: number;
    receipt_date: string;
    family_member_id: string;
    created_at: string;
  }> = [];
  if (!skipReceipts) {
    let rq = sb.from("receipts").select(
      "id, merchant, total, currency, total_pln, receipt_date, family_member_id, created_at",
    ).eq("archived", false);
    if (search) rq = rq.ilike("merchant", `%${search}%`);
    if (validMember) rq = rq.eq("family_member_id", validMember);
    rq = rq.gte("receipt_date", win.start).lte("receipt_date", win.end);
    rq = rq.order("created_at", { ascending: false }).limit(200);
    const rRes = await rq;
    if (rRes.error) return json(req, { error: rRes.error.message }, 500);
    receipts = (rRes.data ?? []) as Array<{
      id: string;
      merchant: string | null;
      total: number;
      currency: string;
      total_pln: number;
      receipt_date: string;
      family_member_id: string;
      created_at: string;
    }>;
  }

  // Line counts AND aggregate kind per receipt (single round-trip). The
  // receipt's kind is derived from its children - a receipt with any income
  // line item is treated as income overall (in practice all lines share
  // kind, so this is robust to the common case). Without this, salary-photo
  // screenshots fall into the "expense" feed because receipts hard-code
  // tx_kind='expense' and ignore the underlying rows.
  const receiptIds = receipts.map((r) => r.id);
  const countMap = new Map<string, number>();
  const receiptKindMap = new Map<string, "expense" | "income">();
  if (receiptIds.length > 0) {
    const cnt = await sb.from("expenses").select("receipt_id, kind").in(
      "receipt_id",
      receiptIds,
    ).eq("archived", false);
    for (const row of (cnt.data ?? []) as Array<{ receipt_id: string; kind: string | null }>) {
      countMap.set(row.receipt_id, (countMap.get(row.receipt_id) ?? 0) + 1);
      if (row.kind === "income") receiptKindMap.set(row.receipt_id, "income");
      else if (!receiptKindMap.has(row.receipt_id)) {
        receiptKindMap.set(row.receipt_id, "expense");
      }
    }
  }

  // 2. Solo expenses (no receipt_id). Now includes income rows too -
  // they're filed in the same table, distinguished by tx_kind in the FeedItem.
  let eq = sb.from("expenses").select(
    "id, kind, name, amount, currency, amount_pln, expense_date, category_id, family_member_id, source, needs_review, needs_confirmation, created_at, payment_method, reconciled_at",
  ).eq("archived", false).is("receipt_id", null);
  if (search) eq = eq.ilike("name", `%${search}%`);
  if (validCategory) eq = eq.eq("category_id", validCategory);
  if (validMember) eq = eq.eq("family_member_id", validMember);
  if (validSource) eq = eq.eq("source", validSource);
  eq = eq.gte("expense_date", win.start).lte("expense_date", win.end);
  eq = eq.order("created_at", { ascending: false }).limit(200);
  const eRes = await eq;
  if (eRes.error) return json(req, { error: eRes.error.message }, 500);
  const solos = (eRes.data ?? []) as Array<{
    id: string;
    kind: "expense" | "income";
    name: string;
    amount: number;
    currency: string;
    amount_pln: number;
    expense_date: string;
    category_id: string;
    family_member_id: string;
    needs_review: boolean;
    needs_confirmation: boolean;
    created_at: string;
    payment_method: "card" | "cash" | "transfer" | "unknown";
    reconciled_at: string | null;
  }>;

  const dates = [
    ...receipts.map((r) => r.receipt_date),
    ...solos.map((e) => e.expense_date),
  ];
  const eurRates = await loadEurRates(sb, dates);

  const merged: FeedItem[] = [
    ...receipts.map<FeedItem>((r) => ({
      kind: "receipt",
      tx_kind: receiptKindMap.get(r.id) ?? "expense",
      id: r.id,
      title: r.merchant ?? "(без названия)",
      amount: Number(r.total),
      currency: r.currency,
      amount_pln: Number(r.total_pln),
      amount_eur: plnToEur(Number(r.total_pln), r.receipt_date, eurRates) ?? 0,
      expense_date: r.receipt_date,
      family_member_id: r.family_member_id,
      category_id: null,
      needs_review: false,
      needs_confirmation: false,
      receipt_id: r.id,
      item_count: countMap.get(r.id) ?? 0,
      created_at: r.created_at,
      // Receipts default to card (most photographed receipts are POS / card).
      // Real value comes from the underlying expense rows when reconciled.
      payment_method: "card",
      reconciled: false,
    })),
    ...solos.map<FeedItem>((e) => ({
      kind: "expense",
      tx_kind: e.kind ?? "expense",
      id: e.id,
      title: e.name,
      amount: Number(e.amount),
      currency: e.currency,
      amount_pln: Number(e.amount_pln),
      amount_eur: plnToEur(Number(e.amount_pln), e.expense_date, eurRates) ?? 0,
      expense_date: e.expense_date,
      family_member_id: e.family_member_id,
      category_id: e.category_id,
      needs_review: e.needs_review,
      needs_confirmation: e.needs_confirmation,
      receipt_id: null,
      item_count: 1,
      created_at: e.created_at,
      payment_method: e.payment_method ?? "unknown",
      reconciled: e.reconciled_at != null,
    })),
  ];

  merged.sort((a, b) => a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
  const page = merged.slice(offset, offset + limit);

  return json(req, { items: page, limit, offset, total: merged.length });
});
