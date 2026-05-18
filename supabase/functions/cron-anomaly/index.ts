// cron-anomaly: daily 08:00 UTC. Sums today's expenses, compares to the
// rolling 7-day average. If today > 3x avg, notify the admin via Telegram.
// Per SPEC §7 + M14 acceptance.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";

const MULTIPLIER = 3;

async function notifyAdmin(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const admin = Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID");
  if (!token || !admin) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(admin), text }),
  });
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();
  const weekAgo = addDaysIso(today, -7);

  // 7-day window
  const win = await sb.from("expenses")
    .select("expense_date, amount_pln")
    .eq("archived", false)
    .gte("expense_date", weekAgo)
    .lt("expense_date", today);
  if (win.error) {
    log("error", "anomaly_window_failed", { error: win.error.message });
    return new Response("db error", { status: 500 });
  }
  const winRows = (win.data ?? []) as Array<{ expense_date: string; amount_pln: number }>;
  const dailyTotals = new Map<string, number>();
  for (const r of winRows) {
    dailyTotals.set(
      r.expense_date,
      (dailyTotals.get(r.expense_date) ?? 0) + Number(r.amount_pln),
    );
  }
  const avg = dailyTotals.size > 0
    ? [...dailyTotals.values()].reduce((a, b) => a + b, 0) / dailyTotals.size
    : 0;

  // Today
  const td = await sb.from("expenses")
    .select("amount_pln")
    .eq("archived", false)
    .eq("expense_date", today);
  const todayTotal = ((td.data ?? []) as Array<{ amount_pln: number }>)
    .reduce((acc, r) => acc + Number(r.amount_pln), 0);

  const isAnomaly = avg > 0 && todayTotal > avg * MULTIPLIER;
  log("info", "anomaly_done", { today_total: todayTotal, avg_7d: avg, alert: isAnomaly });
  if (isAnomaly) {
    await notifyAdmin(
      `Anomaly: today=${todayTotal.toFixed(2)} PLN vs 7d avg=${avg.toFixed(2)} (>${MULTIPLIER}x)`,
    );
  }
  return Response.json({ today_total: todayTotal, avg_7d: avg, alert: isAnomaly });
});
