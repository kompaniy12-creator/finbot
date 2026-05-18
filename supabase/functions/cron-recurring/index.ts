// cron-recurring: daily 07:00 UTC. Charges recurring expenses whose
// effective date for the current month is today (with end-of-month
// clamping per SPEC).
//
// Idempotency via last_charged_date check.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { effectiveDateForToday } from "../_shared/eom.ts";
import { todayWarsawIso } from "../_shared/dates.ts";

interface RecurringRow {
  id: string;
  name: string;
  amount: number;
  currency: string;
  category_id: string;
  family_member_id: string;
  day_of_month: number;
  last_charged_date: string | null;
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();

  const res = await sb
    .from("recurring_expenses")
    .select(
      "id, name, amount, currency, category_id, family_member_id, day_of_month, last_charged_date",
    )
    .eq("active", true);
  if (res.error) {
    log("error", "recurring_select_failed", { error: res.error.message });
    return new Response("db error", { status: 500 });
  }

  let charged = 0;
  let skipped = 0;
  for (const r of (res.data ?? []) as RecurringRow[]) {
    const eff = effectiveDateForToday(today, r.day_of_month);
    if (!eff) {
      skipped++;
      continue;
    }
    // Already charged this month?
    if (r.last_charged_date && r.last_charged_date >= today.slice(0, 7) + "-01") {
      skipped++;
      continue;
    }
    const ins = await sb.from("expenses").insert({
      name: r.name,
      expense_date: eff,
      amount: r.amount,
      currency: r.currency,
      amount_pln: r.currency === "PLN" ? r.amount : r.amount, // simple, no FX for recurring
      category_id: r.category_id,
      family_member_id: r.family_member_id,
      source: "text",
      description: "recurring",
    });
    if (!ins.error) {
      charged++;
      await sb.from("recurring_expenses").update({ last_charged_date: eff }).eq("id", r.id);
    } else {
      log("warn", "recurring_insert_failed", { id: r.id, error: ins.error.message });
    }
  }
  log("info", "recurring_done", { charged, skipped });
  return Response.json({ today, charged, skipped });
});
