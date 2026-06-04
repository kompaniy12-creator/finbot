// Aggregated payment-calendar feed for the "📅 Платёжный календарь"
// sub-view inside the Planning tab.
//
//   GET /api-payment-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//   → { items: [{ date, source, name, amount, currency, kind, ref_id, ... }] }
//
// Sources merged into one timeline:
//   planned (planned_payments)
//     - frequency 'once': include if next_due_date in [from, to]
//     - recurring: project from next_due_date forward through 'to',
//                   stepping by week/month/year
//   credit (credits, status=active, payment_day + monthly_payment set)
//     - project monthly payments on payment_day from max(today, from)
//       up to 'to', capped by remaining_balance / monthly_payment
//   debt (debts, status=active, due_date set)
//     - single event if due_date in [from, to]

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function isoAdd(date: string, days: number): string {
  return new Date(new Date(date + "T00:00:00Z").getTime() + days * 86_400_000)
    .toISOString().slice(0, 10);
}

function clampDay(year: number, month: number, day: number): string {
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, dim)).padStart(2, "0")}`;
}

function advance(date: string, freq: "once" | "weekly" | "monthly" | "yearly"): string | null {
  if (freq === "once") return null;
  if (freq === "weekly") return isoAdd(date, 7);
  const [y, m, d] = date.split("-").map(Number);
  if (freq === "yearly") return clampDay(y! + 1, m!, d!);
  // monthly
  const ny = m! === 12 ? y! + 1 : y!;
  const nm = m! === 12 ? 1 : m! + 1;
  return clampDay(ny, nm, d!);
}

interface CalendarItem {
  date: string;
  source: "planned" | "credit" | "debt";
  name: string;
  amount: number;
  currency: string;
  kind: "expense" | "income";
  ref_id: string;
  category_name?: string | null;
  status?: string;
  meta?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  let q: z.infer<typeof QuerySchema>;
  try {
    q = QuerySchema.parse({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
  } catch (_e) {
    return json(req, { error: "bad_query" }, 400);
  }
  if (q.from > q.to) return json(req, { error: "from_after_to" }, 400);

  const today = todayWarsawIso();
  const items: CalendarItem[] = [];

  // --- Planned payments ---------------------------------------------------
  const pps = await sb.from("planned_payments")
    .select(
      "id, kind, name, amount, currency, frequency, next_due_date, category_id, auto_confirm",
    )
    .eq("active", true);
  type PP = {
    id: string;
    kind: "expense" | "income";
    name: string;
    amount: number;
    currency: string;
    frequency: "once" | "weekly" | "monthly" | "yearly";
    next_due_date: string;
    category_id: string | null;
    auto_confirm: boolean;
  };
  // Pre-fetch category names referenced by planned payments + credits + debts.
  const catIds = new Set<string>();
  for (const p of (pps.data ?? []) as PP[]) {
    if (p.category_id) catIds.add(p.category_id);
  }

  // --- Credits -----------------------------------------------------------
  const credits = await sb.from("credits")
    .select(
      "id, name, lender, currency, monthly_payment, payment_day, remaining_balance, status, type",
    )
    .eq("status", "active");
  type Credit = {
    id: string;
    name: string;
    lender: string | null;
    currency: string;
    monthly_payment: number | null;
    payment_day: number | null;
    remaining_balance: number;
    status: string;
    type: string;
  };

  // --- Debts -------------------------------------------------------------
  const debts = await sb.from("debts")
    .select("id, direction, counterparty, currency, remaining_balance, due_date, status")
    .eq("status", "active")
    .not("due_date", "is", null);
  type Debt = {
    id: string;
    direction: "i_owe" | "owed_to_me";
    counterparty: string;
    currency: string;
    remaining_balance: number;
    due_date: string;
    status: string;
  };

  // Resolve category names in one go.
  const catMap = new Map<string, string>();
  if (catIds.size > 0) {
    const cres = await sb.from("categories").select("id, name").in("id", [...catIds]);
    for (const c of (cres.data ?? []) as Array<{ id: string; name: string }>) {
      catMap.set(c.id, c.name);
    }
  }

  // Project planned payments.
  for (const p of (pps.data ?? []) as PP[]) {
    let cur: string | null = p.next_due_date;
    // Advance past 'from' if the next_due_date is before window.
    let safety = 0;
    while (cur && cur < q.from) {
      cur = advance(cur, p.frequency);
      if (!cur || safety++ > 600) break;
    }
    while (cur && cur <= q.to) {
      items.push({
        date: cur,
        source: "planned",
        name: p.name,
        amount: Number(p.amount),
        currency: p.currency,
        kind: p.kind,
        ref_id: p.id,
        category_name: p.category_id ? (catMap.get(p.category_id) ?? null) : null,
        meta: p.auto_confirm ? "авто" : undefined,
      });
      if (p.frequency === "once") break;
      cur = advance(cur, p.frequency);
      if (safety++ > 600) break;
    }
  }

  // Project credits as monthly recurring payments on payment_day.
  for (const c of (credits.data ?? []) as Credit[]) {
    if (!c.payment_day || !c.monthly_payment || c.monthly_payment <= 0) continue;
    const remainingPayments = Math.ceil(Number(c.remaining_balance) / Number(c.monthly_payment));
    if (remainingPayments <= 0) continue;

    // First payment date: the first c.payment_day occurrence >= today.
    const [ty, tm, td] = today.split("-").map(Number);
    let py = ty!, pm = tm!;
    if (td! > c.payment_day) {
      pm++;
      if (pm > 12) {
        pm = 1;
        py++;
      }
    }
    let cur = clampDay(py, pm, c.payment_day);
    while (cur < q.from) {
      const next = advance(cur, "monthly");
      if (!next) break;
      cur = next;
    }
    let placed = 0;
    while (cur <= q.to && placed < remainingPayments) {
      items.push({
        date: cur,
        source: "credit",
        name: c.name + (c.lender ? ` (${c.lender})` : ""),
        amount: Number(c.monthly_payment),
        currency: c.currency,
        kind: "expense",
        ref_id: c.id,
        category_name: "Выплаты по кредиту",
        meta: c.type,
      });
      placed++;
      const next = advance(cur, "monthly");
      if (!next) break;
      cur = next;
    }
  }

  // Debts: single event at due_date if in window.
  for (const d of (debts.data ?? []) as Debt[]) {
    if (d.due_date < q.from || d.due_date > q.to) continue;
    items.push({
      date: d.due_date,
      source: "debt",
      name: (d.direction === "i_owe" ? "Должен я: " : "Должны мне: ") + d.counterparty,
      amount: Number(d.remaining_balance),
      currency: d.currency,
      kind: d.direction === "i_owe" ? "expense" : "income",
      ref_id: d.id,
      meta: d.direction,
    });
  }

  // Sort by date, then by source so credits come before debts before
  // planned in a stable order (matters for the same-day stack rendering).
  const order = { credit: 0, debt: 1, planned: 2 };
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (order[a.source] ?? 9) - (order[b.source] ?? 9);
  });

  return json(req, { items, from: q.from, to: q.to });
});
