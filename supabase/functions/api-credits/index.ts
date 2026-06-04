// Credits CRUD + payment recording for the 🏦 Кредит tab.
//
//   GET    /api-credits[?status=active|closed|overdue|all]
//   POST   /api-credits                                     create
//   PATCH  /api-credits?id=<uuid>                           partial update
//   DELETE /api-credits?id=<uuid>                           remove (cascade payments)
//   POST   /api-credits?id=<uuid>&action=payment
//            { amount, paid_at, payment_method, description? }
//
// Recording a payment is the killer feature: it creates a real expense
// row under the "Выплаты по кредиту" category when present (else the
// expense fallback), inserts a credit_payments row linking back to that
// expense, decrements remaining_balance, and auto-closes the credit if
// the balance hits zero. This means: once a credit is in the system,
// the user never has to manually create the matching expense again.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { log } from "../_shared/log.ts";

const CCY = ["PLN", "EUR", "ALL", "USD"] as const;
const TYPE = [
  "cash_loan",
  "installment",
  "credit_card",
  "mortgage",
  "auto_loan",
  "pos_credit",
  "microloan",
  "overdraft",
  "other",
] as const;
const STATUS = ["active", "closed", "overdue"] as const;
const METHOD = ["card", "cash", "transfer"] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(TYPE).default("cash_loan"),
  lender: z.string().max(120).nullable().optional(),
  principal: z.number().positive(),
  currency: z.enum(CCY),
  interest_rate: z.number().min(0).max(1000).default(0),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  term_months: z.number().int().positive().nullable().optional(),
  monthly_payment: z.number().positive().nullable().optional(),
  payment_day: z.number().int().min(1).max(31).nullable().optional(),
  remaining_balance: z.number().min(0).optional(), // defaults to principal on create
  notes: z.string().max(500).nullable().optional(),
  // "Credit for someone" flow: when set, payments against this credit
  // automatically create a debt row from `borrowed_for` to me.
  borrowed_for: z.string().max(120).nullable().optional(),
  auto_create_debt: z.boolean().default(false),
  // Pattern-based match for variable-amount credits (e.g. mBank
  // overdraft interest 'ROZL. OPROC. UJEMN.'). Case-insensitive
  // substring match against expense.name.
  name_pattern: z.string().max(200).nullable().optional(),
});

const UpdateSchema = CreateSchema.partial().extend({
  status: z.enum(STATUS).optional(),
});

const PaymentSchema = z.object({
  amount: z.number().positive(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_method: z.enum(METHOD).default("transfer"),
  description: z.string().max(200).nullable().optional(),
});

function nextPaymentDate(c: {
  payment_day: number | null;
  status: string;
  last_paid_at: string | null;
}, today: string): string | null {
  if (c.status !== "active" || !c.payment_day) return null;
  const [y, m] = today.split("-").map(Number);
  const dim = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const candDay = (yy: number, mm: number) => Math.min(c.payment_day!, dim(yy, mm));
  const todayDay = Number(today.slice(8, 10));
  let yy = y!;
  let mm = m!;
  if (candDay(yy, mm) < todayDay) {
    mm += 1;
    if (mm > 12) {
      mm = 1;
      yy += 1;
    }
  }
  return `${yy}-${String(mm).padStart(2, "0")}-${String(candDay(yy, mm)).padStart(2, "0")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const today = todayWarsawIso();

  if (req.method === "GET") {
    const statusFilter = url.searchParams.get("status") ?? "active";
    let q = sb.from("credits").select(
      "id, family_member_id, name, type, lender, principal, currency, interest_rate, start_date, term_months, monthly_payment, payment_day, remaining_balance, status, notes, borrowed_for, auto_create_debt, name_pattern, created_at",
    ).order("created_at", { ascending: false });
    if (statusFilter !== "all") q = q.eq("status", statusFilter);
    const res = await q;
    if (res.error) return json(req, { error: res.error.message }, 500);
    const credits = (res.data ?? []) as Array<{
      id: string;
      principal: number;
      remaining_balance: number;
      payment_day: number | null;
      status: string;
    }>;

    // Fetch the most recent payment date per credit for next_payment_date computation.
    const ids = credits.map((c) => c.id);
    const lastPaidByCredit = new Map<string, string>();
    if (ids.length > 0) {
      const pays = await sb.from("credit_payments")
        .select("credit_id, paid_at")
        .in("credit_id", ids)
        .order("paid_at", { ascending: false });
      for (const p of (pays.data ?? []) as Array<{ credit_id: string; paid_at: string }>) {
        if (!lastPaidByCredit.has(p.credit_id)) lastPaidByCredit.set(p.credit_id, p.paid_at);
      }
    }

    const items = credits.map((c) => {
      const paid = Number(c.principal) - Number(c.remaining_balance);
      const pct = c.principal > 0 ? Math.round((paid / Number(c.principal)) * 100) : 0;
      return {
        ...c,
        paid_amount: Math.round(paid * 100) / 100,
        paid_pct: Math.max(0, Math.min(100, pct)),
        last_paid_at: lastPaidByCredit.get(c.id) ?? null,
        next_payment_date: nextPaymentDate(
          { ...c, last_paid_at: lastPaidByCredit.get(c.id) ?? null },
          today,
        ),
      };
    });
    return json(req, { items });
  }

  if (req.method === "POST" && url.searchParams.get("action") === "link_past_payments") {
    // Retroactive linking: walk recent expense rows (last 6 months)
    // in this credit's currency whose amount matches the credit's
    // monthly_payment ±5%, and for any that don't already have a
    // source-credit debt, insert one. Used right after the user
    // configures borrowed_for on an already-active credit.
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    const c = await sb.from("credits").select(
      "id, family_member_id, currency, monthly_payment, borrowed_for, auto_create_debt, name, status, name_pattern",
    ).eq("id", id).maybeSingle();
    if (!c.data) return json(req, { error: "not_found" }, 404);
    const cr = c.data as {
      id: string;
      family_member_id: string;
      currency: string;
      monthly_payment: number | null;
      borrowed_for: string | null;
      auto_create_debt: boolean;
      name: string;
      status: string;
      name_pattern: string | null;
    };
    if (cr.family_member_id !== me.id && me.role !== "admin") return forbidden(req);
    if (!cr.borrowed_for || (!cr.monthly_payment && !cr.name_pattern)) {
      return json(req, { error: "credit_not_configured_for_debt" }, 400);
    }

    const sixMonthsAgo = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    // Pattern match (variable amount) takes precedence over amount range.
    let exps: Array<{ id: string; amount: number; expense_date: string }>;
    if (cr.name_pattern && cr.name_pattern.trim().length > 0) {
      const pat = `%${cr.name_pattern.trim().replace(/[%_]/g, "\\$&")}%`;
      const expRes = await sb.from("expenses")
        .select("id, amount, expense_date")
        .eq("family_member_id", cr.family_member_id)
        .eq("kind", "expense")
        .eq("archived", false)
        .eq("currency", cr.currency)
        .gte("expense_date", sixMonthsAgo)
        .ilike("name", pat);
      exps = (expRes.data ?? []) as typeof exps;
    } else {
      const mp = Number(cr.monthly_payment!);
      const tol = Math.max(0.05, 0.05 * mp);
      const expRes = await sb.from("expenses")
        .select("id, amount, expense_date")
        .eq("family_member_id", cr.family_member_id)
        .eq("kind", "expense")
        .eq("archived", false)
        .eq("currency", cr.currency)
        .gte("expense_date", sixMonthsAgo)
        .gte("amount", mp - tol)
        .lte("amount", mp + tol);
      exps = (expRes.data ?? []) as typeof exps;
    }

    if (exps.length === 0) {
      return json(req, { ok: true, created: 0, scanned: 0 });
    }

    // Filter out those that already have a debt row linked.
    const existing = await sb.from("debts")
      .select("source_expense_id")
      .in("source_expense_id", exps.map((e) => e.id));
    const linked = new Set(
      ((existing.data ?? []) as Array<{ source_expense_id: string }>)
        .map((x) => x.source_expense_id),
    );
    const toCreate = exps.filter((e) => !linked.has(e.id));
    if (toCreate.length === 0) {
      return json(req, { ok: true, created: 0, scanned: exps.length });
    }

    const rows = toCreate.map((e) => ({
      family_member_id: cr.family_member_id,
      direction: "owed_to_me" as const,
      counterparty: cr.borrowed_for!,
      amount: e.amount,
      currency: cr.currency,
      remaining_balance: e.amount,
      borrowed_at: e.expense_date,
      status: "active" as const,
      notes: `Авто: платёж по кредиту "${cr.name}" (привязка прошлого)`,
      source_credit_id: cr.id,
      source_expense_id: e.id,
    }));
    const ins = await sb.from("debts").insert(rows);
    if (ins.error) return json(req, { error: ins.error.message }, 500);
    log("info", "credit_link_past_payments", {
      credit_id: cr.id,
      scanned: exps.length,
      created: toCreate.length,
    });
    return json(req, { ok: true, created: toCreate.length, scanned: exps.length });
  }

  if (req.method === "POST" && url.searchParams.get("action") === "payment") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    let body: z.infer<typeof PaymentSchema>;
    try {
      body = PaymentSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const cred = await sb.from("credits")
      .select(
        "id, family_member_id, name, currency, remaining_balance, status, monthly_payment",
      )
      .eq("id", id).maybeSingle();
    if (!cred.data) return json(req, { error: "not_found" }, 404);
    const c = cred.data as {
      id: string;
      family_member_id: string;
      name: string;
      currency: string;
      remaining_balance: number;
      status: string;
    };
    if (c.family_member_id !== me.id && me.role !== "admin") return forbidden(req);
    if (c.status === "closed") return json(req, { error: "credit_closed" }, 409);

    // Find category "Выплаты по кредиту"; fall back to expense fallback.
    const catRes = await sb.from("categories")
      .select("id, name, is_fallback, kind")
      .eq("kind", "expense");
    const cats = (catRes.data ?? []) as Array<{
      id: string;
      name: string;
      is_fallback: boolean;
      kind: string;
    }>;
    const credCat = cats.find((x) => /кредит|выплат/i.test(x.name));
    const fallback = cats.find((x) => x.is_fallback);
    const categoryId = (credCat ?? fallback)?.id;
    if (!categoryId) return json(req, { error: "no_category" }, 500);

    // Insert the expense row.
    const expense = await sb.from("expenses").insert({
      kind: "expense",
      name: `Кредит: ${c.name}`,
      expense_date: body.paid_at,
      amount: body.amount,
      currency: c.currency,
      // We don't FX-convert payments here - the user records the amount
      // they actually paid in the credit's currency. PLN-rate-at-date is
      // good enough for everyone; if it matters, the user can edit later.
      amount_pln: c.currency === "PLN" ? body.amount : body.amount,
      category_id: categoryId,
      family_member_id: c.family_member_id,
      source: "text",
      payment_method: body.payment_method,
      description: body.description ?? `Платёж по кредиту`,
    }).select("id").maybeSingle();
    if (expense.error || !expense.data) {
      return json(req, { error: expense.error?.message ?? "expense_insert_failed" }, 500);
    }
    const expenseId = (expense.data as { id: string }).id;

    // Link payment row.
    await sb.from("credit_payments").insert({
      credit_id: id,
      expense_id: expenseId,
      amount: body.amount,
      paid_at: body.paid_at,
    });

    // Decrement balance + auto-close if depleted.
    const newBalance = Math.max(0, Number(c.remaining_balance) - body.amount);
    const newStatus = newBalance <= 0 ? "closed" : c.status;
    const upd = await sb.from("credits").update({
      remaining_balance: newBalance,
      status: newStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);

    log("info", "credit_payment_recorded", {
      credit_id: id,
      expense_id: expenseId,
      new_balance: newBalance,
      new_status: newStatus,
    });
    return json(req, {
      ok: true,
      expense_id: expenseId,
      remaining_balance: newBalance,
      status: newStatus,
    });
  }

  if (req.method === "POST") {
    let body: z.infer<typeof CreateSchema>;
    try {
      body = CreateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const ins = await sb.from("credits").insert({
      family_member_id: me.id,
      name: body.name,
      type: body.type,
      lender: body.lender ?? null,
      principal: body.principal,
      currency: body.currency,
      interest_rate: body.interest_rate,
      start_date: body.start_date,
      term_months: body.term_months ?? null,
      monthly_payment: body.monthly_payment ?? null,
      payment_day: body.payment_day ?? null,
      remaining_balance: body.remaining_balance ?? body.principal,
      notes: body.notes ?? null,
      borrowed_for: body.borrowed_for ?? null,
      auto_create_debt: body.auto_create_debt,
      name_pattern: body.name_pattern ?? null,
    }).select("id").maybeSingle();
    if (ins.error) return json(req, { error: ins.error.message }, 500);
    log("info", "credit_created", { id: (ins.data as { id: string }).id });
    return json(req, { ok: true, id: (ins.data as { id: string }).id });
  }

  if (req.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    let body: z.infer<typeof UpdateSchema>;
    try {
      body = UpdateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const before = await sb.from("credits")
      .select("family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);

    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body) as (keyof z.infer<typeof UpdateSchema>)[]) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) return json(req, { ok: true, unchanged: true });
    patch.updated_at = new Date().toISOString();
    const upd = await sb.from("credits").update(patch).eq("id", id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);
    return json(req, { ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    const before = await sb.from("credits")
      .select("family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);
    const del = await sb.from("credits").delete().eq("id", id);
    if (del.error) return json(req, { error: del.error.message }, 500);
    return json(req, { ok: true, deleted_id: id });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
