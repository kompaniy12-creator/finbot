// cron-month-summary: 1st of each month. Tenant-aware: for each tenant builds a
// recap of the PREVIOUS month (total, vs prior month, top categories) plus a
// short Claude-written note billed to THAT tenant's own API key, and sends it
// via that tenant's bot. Tenants with no spend last month are skipped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { loadEurRates, plnToEur } from "../_shared/eur_view.ts";
import { callClaude } from "../_shared/claude.ts";
import {
  type CronMember,
  loadActiveTenants,
  loadBotTokens,
  sendTg,
} from "../_shared/cron_tenants.ts";

function previousMonth(today: string): { start: string; end: string; ym: string } {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const py = m === 1 ? y! - 1 : y!;
  const pm = m === 1 ? 12 : m! - 1;
  const start = `${py}-${String(pm).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const end = `${py}-${String(pm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end, ym: `${py}-${String(pm).padStart(2, "0")}` };
}

async function buildMonthText(
  sb: SupabaseClient,
  tenantId: string,
  members: CronMember[],
): Promise<string | null> {
  const db = tenantDb(sb, tenantId);
  const today = todayWarsawIso();
  const prev = previousMonth(today);
  const prior = previousMonth(prev.start);

  const [prevRowsRes, priorRowsRes, catRes] = await Promise.all([
    db.from("expenses").select("amount, currency, amount_pln, category_id, expense_date")
      .eq("archived", false).eq("kind", "expense")
      .gte("expense_date", prev.start).lte("expense_date", prev.end),
    db.from("expenses").select("amount_pln, expense_date")
      .eq("archived", false).eq("kind", "expense")
      .gte("expense_date", prior.start).lte("expense_date", prior.end),
    db.from("categories").select("id, name"),
  ]);

  const prevRows = (prevRowsRes.data ?? []) as Array<
    {
      amount: number;
      currency: string;
      amount_pln: number;
      category_id: string;
      expense_date: string;
    }
  >;
  if (prevRows.length === 0) return null;
  const priorRows = (priorRowsRes.data ?? []) as Array<
    { amount_pln: number; expense_date: string }
  >;
  const catName = new Map(
    ((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  const dates = [...prevRows.map((r) => r.expense_date), ...priorRows.map((r) => r.expense_date)];
  const eurRates = await loadEurRates(sb, dates);

  let totalEur = 0;
  const byCat = new Map<string, number>();
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

  // Short Claude recap, billed to this tenant's own key. If the tenant has no
  // key (NO_API_KEY) or the call fails, we just skip the recap.
  let recap = "";
  const billingMember = members[0]?.id;
  if (billingMember) {
    try {
      const { response } = await callClaude({
        sb,
        familyMemberId: billingMember,
        tenantId,
        model: Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
        system: [{
          type: "text",
          text:
            "Ты помощник по личным финансам. Напиши 2-3 коротких предложения на русском о том как прошёл месяц по тратам. " +
            "Сравни с предыдущим месяцем и выдели интересное. Тон дружелюбный, конкретный, без воды. Сразу к делу.",
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
  return headline + deltaLine + topLine + recapLine;
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const botTokens = await loadBotTokens(sb);
  const tenants = await loadActiveTenants(sb);

  let sent = 0, tenantsNotified = 0;
  for (const t of tenants) {
    let text: string | null = null;
    try {
      text = await buildMonthText(sb, t.tenantId, t.members);
    } catch (err) {
      log("warn", "month_summary_tenant_failed", {
        tenant: t.tenantId,
        error: (err as Error).message,
      });
    }
    if (!text) continue;
    tenantsNotified++;
    for (const m of t.members) {
      if (await sendTg(botTokens.get(m.bot_id ?? ""), m.telegram_id, text)) sent++;
    }
  }
  log("info", "month_summary_sent", { sent, tenants_notified: tenantsNotified });
  return Response.json({ sent, tenants_notified: tenantsNotified });
});
