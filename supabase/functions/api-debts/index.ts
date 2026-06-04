// Debts CRUD + payment recording for the 🤝 Долги tab.
//
//   GET    /api-debts[?direction=i_owe|owed_to_me|all][&status=active|closed|all]
//   POST   /api-debts                                       create
//   PATCH  /api-debts?id=<uuid>                             partial update
//   DELETE /api-debts?id=<uuid>                             remove (cascade payments)
//   POST   /api-debts?id=<uuid>&action=payment
//            { amount, paid_at, payment_method?, description? }
//
// Recording a payment:
//   - i_owe       -> creates an EXPENSE row (kind='expense') in the
//                    "Выплата долгов" / "Долги" category if present,
//                    otherwise expense-fallback. Money flows OUT.
//   - owed_to_me  -> creates an INCOME row (kind='income') in the
//                    "Возврат долгов" income category if present,
//                    otherwise income-fallback. Money flows IN.
// Both cases decrement remaining_balance and auto-close the debt when
// the balance hits zero.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { log } from "../_shared/log.ts";

const CCY = ["PLN", "EUR", "ALL", "USD"] as const;
const DIR = ["i_owe", "owed_to_me"] as const;
const STATUS = ["active", "closed", "overdue"] as const;
const METHOD = ["card", "cash", "transfer"] as const;

const CreateSchema = z.object({
  direction: z.enum(DIR),
  counterparty: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(CCY),
  remaining_balance: z.number().min(0).optional(), // defaults to amount on create
  borrowed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notify_3d_before: z.boolean().default(true),
  notify_on_due: z.boolean().default(true),
  notify_overdue: z.boolean().default(true),
  notes: z.string().max(500).nullable().optional(),
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const today = todayWarsawIso();

  if (req.method === "GET") {
    const direction = url.searchParams.get("direction") ?? "all";
    const statusFilter = url.searchParams.get("status") ?? "active";
    let q = sb.from("debts").select(
      "id, family_member_id, direction, counterparty, amount, currency, remaining_balance, borrowed_at, due_date, notify_3d_before, notify_on_due, notify_overdue, status, notes, source_credit_id, source_expense_id, created_at",
    ).order("created_at", { ascending: false });
    if (direction !== "all") q = q.eq("direction", direction);
    if (statusFilter !== "all") q = q.eq("status", statusFilter);
    const res = await q;
    if (res.error) return json(req, { error: res.error.message }, 500);
    const rows = (res.data ?? []) as Array<{
      id: string;
      amount: number;
      remaining_balance: number;
      due_date: string | null;
      status: string;
    }>;
    // Hydrate linked credit names so the Mini App can show "Дополнительно
    // уменьшит остаток по кредиту <name>" hint in the payment modal.
    const allRows = (res.data ?? []) as Array<{ source_credit_id: string | null }>;
    const creditIds = [
      ...new Set(
        allRows.map((r) => r.source_credit_id).filter((x): x is string => !!x),
      ),
    ];
    const creditNames = new Map<string, string>();
    if (creditIds.length > 0) {
      const cr = await sb.from("credits").select("id, name").in("id", creditIds);
      for (const c of (cr.data ?? []) as Array<{ id: string; name: string }>) {
        creditNames.set(c.id, c.name);
      }
    }
    const items = rows.map((d) => {
      const paid = Number(d.amount) - Number(d.remaining_balance);
      const pct = d.amount > 0 ? Math.round((paid / Number(d.amount)) * 100) : 0;
      const isOverdue = d.status === "active" && d.due_date !== null &&
        d.due_date < today;
      const rowFull = d as typeof d & { source_credit_id: string | null };
      return {
        ...d,
        paid_amount: Math.round(paid * 100) / 100,
        paid_pct: Math.max(0, Math.min(100, pct)),
        is_overdue: isOverdue,
        days_to_due: d.due_date
          ? Math.floor(
            (new Date(d.due_date + "T00:00:00Z").getTime() -
              new Date(today + "T00:00:00Z").getTime()) / 86_400_000,
          )
          : null,
        source_credit_name: rowFull.source_credit_id
          ? (creditNames.get(rowFull.source_credit_id) ?? null)
          : null,
      };
    });
    return json(req, { items });
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
    const dr = await sb.from("debts")
      .select(
        "id, family_member_id, direction, counterparty, currency, remaining_balance, status, source_credit_id",
      )
      .eq("id", id).maybeSingle();
    if (!dr.data) return json(req, { error: "not_found" }, 404);
    const d = dr.data as {
      id: string;
      family_member_id: string;
      direction: "i_owe" | "owed_to_me";
      counterparty: string;
      currency: string;
      remaining_balance: number;
      status: string;
      source_credit_id: string | null;
    };
    if (d.family_member_id !== me.id && me.role !== "admin") return forbidden(req);
    if (d.status === "closed") return json(req, { error: "debt_closed" }, 409);

    // Find a matching category for the right kind.
    const wantKind: "expense" | "income" = d.direction === "i_owe" ? "expense" : "income";
    const catRes = await sb.from("categories")
      .select("id, name, is_fallback, kind")
      .eq("kind", wantKind);
    const cats = (catRes.data ?? []) as Array<{
      id: string;
      name: string;
      is_fallback: boolean;
      kind: string;
    }>;
    // Heuristic: any category whose name mentions "долг" / "возврат" wins.
    const matched = cats.find((c) => /долг|возврат/i.test(c.name));
    const fallback = cats.find((c) => c.is_fallback);
    const categoryId = (matched ?? fallback)?.id;
    if (!categoryId) return json(req, { error: "no_category" }, 500);

    const verbRu = d.direction === "i_owe" ? "Выплата долга" : "Возврат долга";
    const expense = await sb.from("expenses").insert({
      kind: wantKind,
      name: `${verbRu}: ${d.counterparty}`,
      expense_date: body.paid_at,
      amount: body.amount,
      currency: d.currency,
      amount_pln: d.currency === "PLN" ? body.amount : body.amount,
      category_id: categoryId,
      family_member_id: d.family_member_id,
      source: "text",
      payment_method: body.payment_method,
      description: body.description ?? verbRu,
    }).select("id").maybeSingle();
    if (expense.error || !expense.data) {
      return json(req, { error: expense.error?.message ?? "expense_insert_failed" }, 500);
    }
    const expenseId = (expense.data as { id: string }).id;

    await sb.from("debt_payments").insert({
      debt_id: id,
      expense_id: expenseId,
      amount: body.amount,
      paid_at: body.paid_at,
    });

    const newBalance = Math.max(0, Number(d.remaining_balance) - body.amount);
    const newStatus = newBalance <= 0 ? "closed" : d.status;
    const upd = await sb.from("debts").update({
      remaining_balance: newBalance,
      status: newStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);

    // If this debt traces back to a credit (e.g. an mBank overdraft
    // charge for a friend who owes us), Denis's return also pays down
    // that credit's principal directly - the cash hits the same bank
    // account the credit lives on. No second expense row: that would
    // double-count, since the original credit interest debit is
    // already in expenses.
    let creditApplied: {
      id: string;
      new_balance: number;
      new_status: string;
    } | null = null;
    if (d.direction === "owed_to_me" && d.source_credit_id) {
      const cr = await sb.from("credits")
        .select("id, remaining_balance, status, currency")
        .eq("id", d.source_credit_id).maybeSingle();
      if (cr.data) {
        const c = cr.data as {
          id: string;
          remaining_balance: number;
          status: string;
          currency: string;
        };
        // Only apply if currencies line up - otherwise we'd silently
        // subtract PLN from a EUR credit. Cross-currency repayment is
        // a rare edge case the user can do manually for now.
        if (c.currency === d.currency && c.status !== "closed") {
          const newCreditBal = Math.max(0, Number(c.remaining_balance) - body.amount);
          const newCreditStatus = newCreditBal <= 0 ? "closed" : c.status;
          const cu = await sb.from("credits").update({
            remaining_balance: newCreditBal,
            status: newCreditStatus,
            updated_at: new Date().toISOString(),
          }).eq("id", c.id);
          if (!cu.error) {
            creditApplied = {
              id: c.id,
              new_balance: newCreditBal,
              new_status: newCreditStatus,
            };
          } else {
            log("warn", "credit_apply_failed", {
              debt_id: id,
              credit_id: c.id,
              error: cu.error.message,
            });
          }
        }
      }
    }

    log("info", "debt_payment_recorded", {
      debt_id: id,
      direction: d.direction,
      expense_id: expenseId,
      new_balance: newBalance,
      new_status: newStatus,
      credit_applied: creditApplied,
    });
    return json(req, {
      ok: true,
      expense_id: expenseId,
      credit_applied: creditApplied,
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
    const ins = await sb.from("debts").insert({
      family_member_id: me.id,
      direction: body.direction,
      counterparty: body.counterparty,
      amount: body.amount,
      currency: body.currency,
      remaining_balance: body.remaining_balance ?? body.amount,
      borrowed_at: body.borrowed_at,
      due_date: body.due_date ?? null,
      notify_3d_before: body.notify_3d_before,
      notify_on_due: body.notify_on_due,
      notify_overdue: body.notify_overdue,
      notes: body.notes ?? null,
    }).select("id").maybeSingle();
    if (ins.error) return json(req, { error: ins.error.message }, 500);
    log("info", "debt_created", {
      id: (ins.data as { id: string }).id,
      direction: body.direction,
    });
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
    const before = await sb.from("debts")
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
    const upd = await sb.from("debts").update(patch).eq("id", id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);
    return json(req, { ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    const before = await sb.from("debts")
      .select("family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);
    const del = await sb.from("debts").delete().eq("id", id);
    if (del.error) return json(req, { error: del.error.message }, 500);
    return json(req, { ok: true, deleted_id: id });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
