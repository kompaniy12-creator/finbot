// cron-anomaly: daily. Tenant-aware: for each tenant, compares today's spend to
// its rolling 7-day average; if today > 3x avg, alerts that tenant's members via
// their own bot. Income surges don't trip it (expense kind only).

import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";
import { loadActiveTenants, loadBotTokens, sendTg } from "../_shared/cron_tenants.ts";

const MULTIPLIER = 3;

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();
  const weekAgo = addDaysIso(today, -7);
  const botTokens = await loadBotTokens(sb);
  const tenants = await loadActiveTenants(sb);

  let alerts = 0;
  for (const t of tenants) {
    const db = tenantDb(sb, t.tenantId);
    const win = await db.from("expenses")
      .select("expense_date, amount_pln")
      .eq("archived", false).eq("kind", "expense")
      .gte("expense_date", weekAgo).lt("expense_date", today);
    if (win.error) continue;
    const dailyTotals = new Map<string, number>();
    for (const r of (win.data ?? []) as Array<{ expense_date: string; amount_pln: number }>) {
      dailyTotals.set(
        r.expense_date,
        (dailyTotals.get(r.expense_date) ?? 0) + Number(r.amount_pln),
      );
    }
    const avg = dailyTotals.size > 0
      ? [...dailyTotals.values()].reduce((a, b) => a + b, 0) / dailyTotals.size
      : 0;

    const td = await db.from("expenses")
      .select("amount_pln")
      .eq("archived", false).eq("kind", "expense").eq("expense_date", today);
    const todayTotal = ((td.data ?? []) as Array<{ amount_pln: number }>)
      .reduce((acc, r) => acc + Number(r.amount_pln), 0);

    if (avg > 0 && todayTotal > avg * MULTIPLIER) {
      alerts++;
      const text = `⚠️ Необычно крупные траты сегодня: ${todayTotal.toFixed(0)} PLN ` +
        `при средних ${avg.toFixed(0)} PLN/день за неделю (больше чем в ${MULTIPLIER}x). ` +
        `Проверь, всё ли верно.`;
      for (const m of t.members) await sendTg(botTokens.get(m.bot_id ?? ""), m.telegram_id, text);
    }
  }
  log("info", "anomaly_done", { tenants: tenants.length, alerts });
  return Response.json({ tenants: tenants.length, alerts });
});
