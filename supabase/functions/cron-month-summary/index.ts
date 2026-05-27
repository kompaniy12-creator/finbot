// cron-month-summary: 1st of each month at 07:00 UTC (~09:00 Warsaw).
// Sends each active family member a Claude-written 2-3 sentence recap of
// the PREVIOUS month: total spend, vs prior month, top categories, biggest
// surprise. Single Anthropic call per family (~$0.002 of Haiku), once a
// month - negligible cost.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { addDaysIso, todayWarsawIso } from "../_shared/dates.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";
import { callClaude } from "../_shared/claude.ts";

function previousMonth(today: string): { start: string; end: string; ym: string } {
  // today YYYY-MM-DD -> previous month bounds
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const py = m === 1 ? y! - 1 : y!;
  const pm = m === 1 ? 12 : m! - 1;
  const start = `${py}-${String(pm).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const end = `${py}-${String(pm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end, ym: `${py}-${String(pm).padStart(2, "0")}` };
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
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    log("warn", "month_summary_tg_failed", { chat_id: chatId, error: (err as Error).message });
  }
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();

  const today = todayWarsawIso();
  const prev = previousMonth(today);
  // Window for "prior" comparison (month BEFORE prev)
  const prior = previousMonth(prev.start);

  // Pull rows for both windows in parallel.
  const [prevRowsRes, priorRowsRes, famRes, catRes] = await Promise.all([
    sb.from("expenses")
      .select("amount, currency, amount_pln, category_id, expense_date")
      .eq("archived", false)
      .gte("expense_date", prev.start).lte("expense_date", prev.end),
    sb.from("expenses")
      .select("amount_pln, expense_date")
      .eq("archived", false)
      .gte("expense_date", prior.start).lte("expense_date", prior.end),
    sb.from("family_members").select("id, telegram_id, active").eq("active", true),
    sb.from("categories").select("id, name"),
  ]);

  const prevRows = (prevRowsRes.data ?? []) as Array<{
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    expense_date: string;
  }>;
  const priorRows = (priorRowsRes.data ?? []) as Array<{
    amount_pln: number;
    expense_date: string;
  }>;
  const members = (famRes.data ?? []) as Array<{
    id: string;
    telegram_id: number;
    active: boolean;
  }>;
  const catName = new Map(
    ((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  if (prevRows.length === 0) {
    log("info", "month_summary_no_data", { month: prev.ym });
    return Response.json({ sent: 0, reason: "no data" });
  }

  const dates = [
    ...prevRows.map((r) => r.expense_date),
    ...priorRows.map((r) => r.expense_date),
  ];
  const eurRates = await loadEurRates(sb, dates);

  let totalEur = 0;
  const byCat = new Map<string, number>(); // EUR
  for (const r of prevRows) {
    const eur = plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
    totalEur += eur;
    byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + eur);
  }
  let priorEur = 0;
  for (const r of priorRows) {
    priorEur += plnToEur(Number(r.amount_pln), r.expense_date, eurRates) ?? 0;
  }
  totalEur = Math.round(totalEur * 100) / 100;
  priorEur = Math.round(priorEur * 100) / 100;
  const deltaPct = priorEur > 0 ? Math.round(((totalEur - priorEur) / priorEur) * 1000) / 10 : null;

  const top = [...byCat.entries()]
    .map(([id, eur]) => ({ name: catName.get(id) ?? "?", eur: Math.round(eur * 100) / 100 }))
    .sort((a, b) => b.eur - a.eur)
    .slice(0, 5);

  // Ask Claude Haiku for a short Russian recap. Bill the Anthropic usage to
  // the first admin so the budget ledger has a real owner; family-level call.
  let recap = "";
  const billingMember = members.find((m) => m.active)?.id;
  if (billingMember) {
    try {
      const { response } = await callClaude({
        sb,
        familyMemberId: billingMember,
        model: Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
        system: [{
          type: "text",
          text:
            "Ты помощник по личным финансам семьи. Напиши 2-3 коротких предложения на русском о том как прошёл месяц по тратам. " +
            "Сравни с предыдущим месяцем и выдели интересное (рост / падение в категориях). " +
            "Тон: дружелюбный, конкретный, без воды. Не приветствуй, сразу к делу. Не повторяй цифры построчно - найди главное.",
        }],
        messages: [{
          role: "user",
          content: [
            `Месяц: ${prev.ym}.`,
            `Всего: ${totalEur.toFixed(2)} EUR (${prevRows.length} записей).`,
            priorEur > 0
              ? `Прошлый месяц: ${priorEur.toFixed(2)} EUR (изменение ${
                deltaPct === null ? "n/a" : `${deltaPct > 0 ? "+" : ""}${deltaPct}%`
              }).`
              : `Прошлый месяц: данных нет.`,
            `Топ-5 категорий:`,
            ...top.map((t, i) => `  ${i + 1}. ${t.name}: ${t.eur} EUR`),
          ].join("\n"),
        }],
        maxTokens: 300,
      });
      const text = response.content.find((c) => c.type === "text")?.text?.trim();
      if (text) recap = text;
    } catch (err) {
      log("warn", "month_summary_claude_failed", { error: (err as Error).message });
    }
  }

  const headline = `📅 Итоги ${prev.ym}: ${totalEur.toFixed(2)} EUR за ${prevRows.length} записей`;
  const deltaLine = priorEur > 0
    ? `\nПрошлый месяц: ${priorEur.toFixed(2)} EUR (${
      deltaPct === null ? "" : (deltaPct > 0 ? "+" : "") + deltaPct + "%"
    })`
    : "";
  const topLine = top.length > 0
    ? `\n\nТоп-категории:\n` + top.map((t) => `- ${t.name}: ${t.eur} EUR`).join("\n")
    : "";
  const recapLine = recap ? `\n\n${recap}` : "";

  const text = headline + deltaLine + topLine + recapLine;

  let sent = 0;
  for (const m of members) {
    await sendTg(m.telegram_id, text);
    sent++;
  }
  log("info", "month_summary_sent", {
    sent,
    month: prev.ym,
    total_eur: totalEur,
    prior_eur: priorEur,
    had_recap: Boolean(recap),
  });
  return Response.json({ sent, total_eur: totalEur, month: prev.ym });
});

// Silence unused-var lint when addDaysIso isn't strictly needed.
void addDaysIso;
