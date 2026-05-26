// GET /api-transactions?limit=N&offset=M&search=...
// Returns a unified feed of "transactions" where each item is either:
//   - kind="receipt": one row per receipt (merchant + total + item_count)
//   - kind="expense": standalone expense (no receipt_id)
// Sorted by created_at desc. Search matches receipt.merchant or expense.name.

import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { resolveDateWindow } from "../_shared/period.ts";

interface FeedItem {
  kind: "receipt" | "expense";
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
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  const search = (url.searchParams.get("search") ?? "").trim();
  const hasRange = url.searchParams.has("from") || url.searchParams.has("to") ||
    url.searchParams.has("period");
  const today = todayWarsawIso();
  const win = hasRange ? resolveDateWindow(url, today) : null;

  // Build SQL via Management API isn't available from Edge; use supabase-js with
  // two queries + merge in JS. This keeps the endpoint stateless.

  // Family-wide feed: every member sees every member's transactions.
  void me;
  // 1. Receipts (one row per receipt) with line counts.
  let rq = sb.from("receipts").select(
    "id, merchant, total, currency, total_pln, receipt_date, family_member_id, created_at",
  ).eq("archived", false);
  if (search) rq = rq.ilike("merchant", `%${search}%`);
  if (win) rq = rq.gte("receipt_date", win.start).lte("receipt_date", win.end);
  rq = rq.order("created_at", { ascending: false }).limit(200);
  const rRes = await rq;
  if (rRes.error) return json(req, { error: rRes.error.message }, 500);
  const receipts = (rRes.data ?? []) as Array<{
    id: string;
    merchant: string | null;
    total: number;
    currency: string;
    total_pln: number;
    receipt_date: string;
    family_member_id: string;
    created_at: string;
  }>;

  // Line counts per receipt (single round-trip).
  const receiptIds = receipts.map((r) => r.id);
  const countMap = new Map<string, number>();
  if (receiptIds.length > 0) {
    const cnt = await sb.from("expenses").select("receipt_id").in("receipt_id", receiptIds).eq(
      "archived",
      false,
    );
    for (const row of (cnt.data ?? []) as Array<{ receipt_id: string }>) {
      countMap.set(row.receipt_id, (countMap.get(row.receipt_id) ?? 0) + 1);
    }
  }

  // 2. Solo expenses (no receipt_id).
  let eq = sb.from("expenses").select(
    "id, name, amount, currency, amount_pln, expense_date, category_id, family_member_id, source, needs_review, needs_confirmation, created_at",
  ).eq("archived", false).is("receipt_id", null);
  if (search) eq = eq.ilike("name", `%${search}%`);
  if (win) eq = eq.gte("expense_date", win.start).lte("expense_date", win.end);
  eq = eq.order("created_at", { ascending: false }).limit(200);
  const eRes = await eq;
  if (eRes.error) return json(req, { error: eRes.error.message }, 500);
  const solos = (eRes.data ?? []) as Array<{
    id: string;
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
  }>;

  const dates = [
    ...receipts.map((r) => r.receipt_date),
    ...solos.map((e) => e.expense_date),
  ];
  const eurRates = await loadEurRates(sb, dates);

  const merged: FeedItem[] = [
    ...receipts.map<FeedItem>((r) => ({
      kind: "receipt",
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
    })),
    ...solos.map<FeedItem>((e) => ({
      kind: "expense",
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
    })),
  ];

  merged.sort((a, b) => a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
  const page = merged.slice(offset, offset + limit);

  return json(req, { items: page, limit, offset, total: merged.length });
});
