// Budgets CRUD + progress for the "Бюджеты" sub-view.
//
//   GET    /api-budgets                   -> [{ ...budget, category_ids, spent_amount, spent_pct }]
//   POST   /api-budgets                   { name, amount, currency, period, category_ids, notify_* }
//   PATCH  /api-budgets?id=<uuid>         { ...partial, category_ids? }
//   DELETE /api-budgets?id=<uuid>
//
// Progress (read-side): sum amount_pln across expenses in this budget's
// categories within [period_start, today], convert to budget.currency
// using TODAY's rate from exchange_rates (rate_pln = PLN per 1 unit).
// PLN budgets skip conversion.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { log } from "../_shared/log.ts";

const CCY = ["PLN", "EUR", "ALL", "USD"] as const;
const PERIOD = ["weekly", "monthly", "yearly"] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(CCY),
  period: z.enum(PERIOD).default("monthly"),
  category_ids: z.array(z.string().uuid()).min(1).max(20),
  notify_on_exceed: z.boolean().default(true),
  notify_at_75: z.boolean().default(true),
});

const UpdateSchema = CreateSchema.partial().extend({
  active: z.boolean().optional(),
});

function periodStart(period: string, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(y!, m! - 1, d!));
  if (period === "weekly") {
    // Monday as week start (Europe/Warsaw convention).
    const dow = todayUtc.getUTCDay(); // 0 = Sun
    const back = (dow + 6) % 7; // Mon -> 0, Sun -> 6
    const start = new Date(todayUtc.getTime() - back * 86_400_000);
    return start.toISOString().slice(0, 10);
  }
  if (period === "yearly") {
    return `${y}-01-01`;
  }
  // monthly default
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

async function latestRate(
  sb: ReturnType<typeof adminClient>,
  currency: string,
): Promise<number> {
  if (currency === "PLN") return 1;
  const r = await sb
    .from("exchange_rates")
    .select("rate_pln")
    .eq("currency", currency)
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = r.data as { rate_pln: number } | null;
  return row?.rate_pln ? Number(row.rate_pln) : 1;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  void me;

  const url = new URL(req.url);

  if (req.method === "GET") {
    const today = todayWarsawIso();
    const [bRes, linkRes] = await Promise.all([
      sb.from("budgets")
        .select(
          "id, family_member_id, name, amount, currency, period, notify_on_exceed, notify_at_75, active, created_at",
        )
        .eq("active", true)
        .order("created_at", { ascending: false }),
      sb.from("budget_categories").select("budget_id, category_id"),
    ]);
    if (bRes.error) return json(req, { error: bRes.error.message }, 500);
    const budgets = (bRes.data ?? []) as Array<{
      id: string;
      family_member_id: string;
      name: string;
      amount: number;
      currency: string;
      period: string;
      notify_on_exceed: boolean;
      notify_at_75: boolean;
      active: boolean;
      created_at: string;
    }>;
    const links = (linkRes.data ?? []) as Array<{ budget_id: string; category_id: string }>;
    const catsByBudget = new Map<string, string[]>();
    for (const l of links) {
      const arr = catsByBudget.get(l.budget_id) ?? [];
      arr.push(l.category_id);
      catsByBudget.set(l.budget_id, arr);
    }

    // Cache rate lookups per currency so we don't hit the DB once per budget.
    const rateCache = new Map<string, number>();
    const rateFor = async (ccy: string): Promise<number> => {
      if (rateCache.has(ccy)) return rateCache.get(ccy)!;
      const r = await latestRate(sb, ccy);
      rateCache.set(ccy, r);
      return r;
    };

    const items = [];
    for (const b of budgets) {
      const catIds = catsByBudget.get(b.id) ?? [];
      const startIso = periodStart(b.period, today);
      let spentPln = 0;
      if (catIds.length > 0) {
        const exp = await sb
          .from("expenses")
          .select("amount_pln")
          .eq("archived", false)
          .eq("kind", "expense")
          .in("category_id", catIds)
          .gte("expense_date", startIso)
          .lte("expense_date", today);
        for (const r of (exp.data ?? []) as Array<{ amount_pln: number }>) {
          spentPln += Number(r.amount_pln) || 0;
        }
      }
      const rate = await rateFor(b.currency);
      const spentAmount = b.currency === "PLN" ? spentPln : spentPln / rate;
      const spentPct = b.amount > 0 ? Math.round((spentAmount / b.amount) * 100) : 0;
      items.push({
        ...b,
        category_ids: catIds,
        period_start: startIso,
        period_end: today,
        spent_amount: Math.round(spentAmount * 100) / 100,
        spent_pln: Math.round(spentPln * 100) / 100,
        spent_pct: spentPct,
      });
    }
    return json(req, { items });
  }

  if (req.method === "POST") {
    let body: z.infer<typeof CreateSchema>;
    try {
      body = CreateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const ins = await sb.from("budgets").insert({
      family_member_id: me.id,
      name: body.name,
      amount: body.amount,
      currency: body.currency,
      period: body.period,
      notify_on_exceed: body.notify_on_exceed,
      notify_at_75: body.notify_at_75,
    }).select("id").maybeSingle();
    if (ins.error || !ins.data) {
      return json(req, { error: ins.error?.message ?? "insert_failed" }, 500);
    }
    const budgetId = (ins.data as { id: string }).id;
    const links = body.category_ids.map((cid) => ({
      budget_id: budgetId,
      category_id: cid,
    }));
    const linkRes = await sb.from("budget_categories").insert(links);
    if (linkRes.error) {
      // Rollback by deleting the budget shell so we don't leave it categoryless.
      await sb.from("budgets").delete().eq("id", budgetId);
      return json(req, { error: linkRes.error.message }, 500);
    }
    log("info", "budget_created", { id: budgetId, cats: body.category_ids.length });
    return json(req, { ok: true, id: budgetId });
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
    const before = await sb.from("budgets")
      .select("family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);

    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body) as (keyof z.infer<typeof UpdateSchema>)[]) {
      if (k === "category_ids") continue;
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const upd = await sb.from("budgets").update(patch).eq("id", id);
      if (upd.error) return json(req, { error: upd.error.message }, 500);
    }
    // Replace category links atomically if provided.
    if (body.category_ids) {
      await sb.from("budget_categories").delete().eq("budget_id", id);
      const ins = await sb.from("budget_categories").insert(
        body.category_ids.map((cid) => ({ budget_id: id, category_id: cid })),
      );
      if (ins.error) return json(req, { error: ins.error.message }, 500);
    }
    log("info", "budget_updated", { id });
    return json(req, { ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);
    const before = await sb.from("budgets")
      .select("family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);

    // budget_categories rows cascade on delete.
    const del = await sb.from("budgets").delete().eq("id", id);
    if (del.error) return json(req, { error: del.error.message }, 500);
    log("info", "budget_deleted", { id });
    return json(req, { ok: true, deleted_id: id });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
