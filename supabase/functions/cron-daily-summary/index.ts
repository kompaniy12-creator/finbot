// cron-daily-summary: every evening at 22:00 Europe/Warsaw.
// Sends each active family member a Telegram message with:
//   - today's total in source-currency breakdown + EUR grand
//   - count of records
//   - top category today
//   - month-to-date total + records
//   - vs yesterday delta (percent in EUR)
//
// Family-wide visibility: every member sees the FAMILY total, not just
// their own (matches the Mini App behaviour).

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";

interface ExpRow {
  amount: number;
  currency: string;
  amount_pln: number;
  category_id: string;
  expense_date: string;
}

async function sendTg(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    log("warn", "daily_summary_tg_failed", { chat_id: chatId, error: (err as Error).message });
  }
}

function fmtCcy(byCcy: Map<string, number>): string {
  // Same stable order as the dashboard: PLN, EUR, USD, ALL, then others A-Z.
  const order = ["PLN", "EUR", "USD", "ALL"];
  const entries = [...byCcy.entries()].sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a[0].localeCompare(b[0]);
  });
  return entries
    .filter(([_, v]) => v > 0)
    .map(([c, v]) => `${c} ${v.toFixed(2)}`)
    .join(", ");
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();
  const yesterday = addDaysIso(today, -1);
  const monthStart = today.slice(0, 7) + "-01";

  // Pull everything we need in one round of queries.
  // CRITICAL: filter kind='expense' on every expense aggregate - otherwise
  // income rows (Зарплата, дивиденды, возврат долгов) inflate totals and
  // dominate the "top category" line, making the summary nonsense.
  const [todayRes, yestRes, monthRes, todayIncRes, monthIncRes, famRes, catRes] = await Promise
    .all([
      sb.from("expenses")
        .select("amount, currency, amount_pln, category_id, expense_date")
        .eq("archived", false).eq("kind", "expense").eq("expense_date", today),
      sb.from("expenses")
        .select("amount_pln, expense_date")
        .eq("archived", false).eq("kind", "expense").eq("expense_date", yesterday),
      sb.from("expenses")
        .select("amount_pln, expense_date")
        .eq("archived", false).eq("kind", "expense")
        .gte("expense_date", monthStart).lte("expense_date", today),
      sb.from("expenses")
        .select("amount_pln, expense_date")
        .eq("archived", false).eq("kind", "income").eq("expense_date", today),
      sb.from("expenses")
        .select("amount_pln, expense_date")
        .eq("archived", false).eq("kind", "income")
        .gte("expense_date", monthStart).lte("expense_date", today),
      sb.from("family_members").select("telegram_id, name, active").eq("active", true),
      sb.from("categories").select("id, name"),
    ]);

  const todayRows = (todayRes.data ?? []) as ExpRow[];
  const yestRows = (yestRes.data ?? []) as Array<{ amount_pln: number; expense_date: string }>;
  const monthRows = (monthRes.data ?? []) as Array<{ amount_pln: number; expense_date: string }>;
  const todayIncRows = (todayIncRes.data ?? []) as Array<
    { amount_pln: number; expense_date: string }
  >;
  const monthIncRows = (monthIncRes.data ?? []) as Array<
    { amount_pln: number; expense_date: string }
  >;
  const members = (famRes.data ?? []) as Array<
    { telegram_id: number; name: string; active: boolean }
  >;
  const catName = new Map(
    ((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  const dates = [
    ...todayRows.map((r) => r.expense_date),
    ...yestRows.map((r) => r.expense_date),
    ...monthRows.map((r) => r.expense_date),
    ...todayIncRows.map((r) => r.expense_date),
    ...monthIncRows.map((r) => r.expense_date),
  ];
  const eurRates = await loadEurRates(sb, dates);

  let todayEur = 0;
  const byCcy = new Map<string, number>();
  const byCat = new Map<string, number>();
  for (const r of todayRows) {
    todayEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
    byCcy.set(r.currency, (byCcy.get(r.currency) ?? 0) + Number(r.amount));
    byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + Number(r.amount_pln));
  }
  let yestEur = 0;
  for (const r of yestRows) {
    yestEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }
  let monthEur = 0;
  for (const r of monthRows) {
    monthEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }
  let todayIncEur = 0;
  for (const r of todayIncRows) {
    todayIncEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }
  let monthIncEur = 0;
  for (const r of monthIncRows) {
    monthIncEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }

  todayEur = Math.round(todayEur * 100) / 100;
  yestEur = Math.round(yestEur * 100) / 100;
  monthEur = Math.round(monthEur * 100) / 100;
  todayIncEur = Math.round(todayIncEur * 100) / 100;
  monthIncEur = Math.round(monthIncEur * 100) / 100;

  const topCat = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  const deltaPct = yestEur > 0 ? Math.round(((todayEur - yestEur) / yestEur) * 1000) / 10 : null;
  const deltaText = deltaPct === null
    ? (yestEur === 0 && todayEur > 0 ? " (вчера 0)" : "")
    : ` (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}% vs вчера)`;

  // Build the message once; same family-wide totals get sent to every active
  // member. Each member sees the same picture as the dashboard.
  const headline = todayRows.length === 0
    ? "📊 Сегодня без трат. Молодцы!"
    : `📊 Сегодня расход: ${todayEur.toFixed(2)} EUR за ${todayRows.length} ${
      todayRows.length === 1 ? "запись" : "записей"
    }${deltaText}`;
  const incomeLine = todayIncEur > 0 ? `\n💰 Доход сегодня: ${todayIncEur.toFixed(2)} EUR` : "";
  const ccyLine = byCcy.size > 0 ? `\nПо валютам: ${fmtCcy(byCcy)}` : "";
  const topLine = topCat ? `\nТоп-категория расходов: ${catName.get(topCat[0]) ?? "?"}` : "";
  const monthExpLine = `\n\nЗа месяц расход: ${monthEur.toFixed(2)} EUR за ${monthRows.length} ${
    monthRows.length === 1 ? "запись" : "записей"
  }`;
  const monthIncLine = monthIncEur > 0 ? `\nЗа месяц доход: ${monthIncEur.toFixed(2)} EUR` : "";
  const monthNet = Math.round((monthIncEur - monthEur) * 100) / 100;
  const monthNetLine = monthIncEur > 0
    ? `\nНетто за месяц: ${monthNet >= 0 ? "+" : ""}${monthNet.toFixed(2)} EUR`
    : "";
  const text = headline + incomeLine + ccyLine + topLine + monthExpLine + monthIncLine +
    monthNetLine;

  let sent = 0;
  for (const m of members) {
    await sendTg(m.telegram_id, text);
    sent++;
  }
  log("info", "daily_summary_sent", {
    sent,
    today_total_eur: todayEur,
    today_count: todayRows.length,
    month_total_eur: monthEur,
  });
  return Response.json({ sent, today_total_eur: todayEur, today_count: todayRows.length });
});
