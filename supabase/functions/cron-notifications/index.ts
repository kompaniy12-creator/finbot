// cron-notifications: daily ~08:00 Warsaw. Sends Telegram reminders for:
//   - planned_payments (3 days before / on due date) + auto-confirm
//     execution that creates the expense/income on due date when
//     auto_confirm=true, then advances next_due_date by frequency
//   - budgets (75% threshold + exceeded) per active period
//   - debts (3 days before / on due date / overdue once)
//
// Idempotency via notifications_log unique (entity_type, entity_id,
// event_key). Each Telegram message is dispatched at most once per
// logical event occurrence.
//
// Auth: Bearer CRON_SECRET. Triggered by pg_cron, see migration 0026.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { notifyUser } from "../_shared/notify.ts";

interface Member {
  id: string;
  telegram_id: number;
  name: string;
}

interface PlannedPayment {
  id: string;
  family_member_id: string;
  kind: "expense" | "income";
  name: string;
  amount: number;
  currency: string;
  category_id: string | null;
  payment_method: string;
  frequency: "once" | "weekly" | "monthly" | "yearly";
  next_due_date: string;
  auto_confirm: boolean;
  notify_on_day: boolean;
  notify_3d_before: boolean;
  active: boolean;
}

interface Budget {
  id: string;
  family_member_id: string;
  name: string;
  amount: number;
  currency: string;
  period: "weekly" | "monthly" | "yearly";
  notify_on_exceed: boolean;
  notify_at_75: boolean;
  active: boolean;
}

interface Debt {
  id: string;
  family_member_id: string;
  direction: "i_owe" | "owed_to_me";
  counterparty: string;
  amount: number;
  currency: string;
  remaining_balance: number;
  due_date: string | null;
  notify_3d_before: boolean;
  notify_on_due: boolean;
  notify_overdue: boolean;
  status: string;
}

function isoAdd(date: string, days: number): string {
  const t = new Date(date + "T00:00:00Z").getTime() + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) /
      86_400_000,
  );
}

function advanceDate(d: string, freq: PlannedPayment["frequency"]): string {
  if (freq === "weekly") return isoAdd(d, 7);
  const [y, m, day] = d.split("-").map(Number);
  if (freq === "yearly") {
    return `${y! + 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  // monthly default
  const ny = m! === 12 ? y! + 1 : y!;
  const nm = m! === 12 ? 1 : m! + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(day!, dim);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

function periodStart(period: Budget["period"], today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  if (period === "weekly") {
    const t = new Date(Date.UTC(y!, m! - 1, d!));
    const back = (t.getUTCDay() + 6) % 7; // Mon=0
    return new Date(t.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  }
  if (period === "yearly") return `${y}-01-01`;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function periodKey(period: Budget["period"], today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  if (period === "weekly") {
    const t = new Date(Date.UTC(y!, m! - 1, d!));
    const thursday = new Date(t.getTime() + ((3 - ((t.getUTCDay() + 6) % 7)) * 86_400_000));
    const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const week = 1 +
      Math.round(
        ((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7,
      );
    return `weekly_${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  if (period === "yearly") return `yearly_${y}`;
  return `monthly_${y}-${String(m).padStart(2, "0")}`;
}

function formatAmount(amount: number, currency: string): string {
  return Number(amount).toFixed(2).replace(/\.00$/, "") + " " + currency;
}

async function sendOnce(
  // deno-lint-ignore no-explicit-any
  sb: any,
  entityType: "planned_payment" | "budget" | "debt",
  entityId: string,
  eventKey: string,
  member: Member,
  text: string,
): Promise<boolean> {
  // Insert log row first - the unique constraint atomically dedupes
  // concurrent runs / retries. If insert fails on conflict, another
  // run already sent it, so we skip the Telegram call.
  const ins = await sb.from("notifications_log").insert({
    entity_type: entityType,
    entity_id: entityId,
    event_key: eventKey,
    family_member_id: member.id,
  });
  if (ins.error) {
    // 23505 unique_violation means we already sent it.
    if (ins.error.code === "23505") return false;
    log("warn", "notifications_log_insert_failed", {
      entity: entityType,
      id: entityId,
      event: eventKey,
      error: ins.error.message,
    });
    return false;
  }
  await notifyUser(member.telegram_id, text);
  return true;
}

async function loadCategoryName(
  // deno-lint-ignore no-explicit-any
  sb: any,
  categoryId: string | null,
): Promise<string | null> {
  if (!categoryId) return null;
  const r = await sb.from("categories").select("name").eq("id", categoryId).maybeSingle();
  return (r.data as { name: string } | null)?.name ?? null;
}

// deno-lint-ignore no-explicit-any
async function latestRate(sb: any, currency: string): Promise<number> {
  if (currency === "PLN") return 1;
  const r = await sb.from("exchange_rates")
    .select("rate_pln").eq("currency", currency)
    .order("rate_date", { ascending: false }).limit(1).maybeSingle();
  const row = r.data as { rate_pln: number } | null;
  return row?.rate_pln ? Number(row.rate_pln) : 1;
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const today = todayWarsawIso();
  const in3 = isoAdd(today, 3);

  // Look up family members once - we need telegram_id to message.
  const membersRes = await sb.from("family_members")
    .select("id, telegram_id, name").eq("active", true);
  const members = new Map<string, Member>();
  for (const m of (membersRes.data ?? []) as Member[]) members.set(m.id, m);

  const stats = {
    planned_3d: 0,
    planned_due: 0,
    planned_auto_executed: 0,
    budget_75: 0,
    budget_over: 0,
    debt_3d: 0,
    debt_due: 0,
    debt_overdue: 0,
  };

  // ---- Planned payments ------------------------------------------------
  const pps = await sb.from("planned_payments")
    .select(
      "id, family_member_id, kind, name, amount, currency, category_id, payment_method, frequency, next_due_date, auto_confirm, notify_on_day, notify_3d_before, active",
    )
    .eq("active", true);
  for (const p of (pps.data ?? []) as PlannedPayment[]) {
    const m = members.get(p.family_member_id);
    if (!m) continue;
    const cat = await loadCategoryName(sb, p.category_id);
    const sign = p.kind === "income" ? "+" : "-";
    const verb = p.kind === "income" ? "Поступление" : "Платёж";

    if (p.notify_3d_before && p.next_due_date === in3) {
      const ok = await sendOnce(
        sb,
        "planned_payment",
        p.id,
        `reminder_3d_${p.next_due_date}`,
        m,
        `📅 Через 3 дня: ${verb} «${p.name}» ${sign}${formatAmount(p.amount, p.currency)}` +
          (cat ? ` (${cat})` : "") +
          `\nДата: ${p.next_due_date}`,
      );
      if (ok) stats.planned_3d++;
    }

    if (p.next_due_date === today) {
      if (p.notify_on_day) {
        const ok = await sendOnce(
          sb,
          "planned_payment",
          p.id,
          `reminder_on_day_${p.next_due_date}`,
          m,
          `🔔 Сегодня: ${verb} «${p.name}» ${sign}${formatAmount(p.amount, p.currency)}` +
            (cat ? ` (${cat})` : ""),
        );
        if (ok) stats.planned_due++;
      }

      if (p.auto_confirm) {
        // Insert the actual expense/income row idempotently via the
        // notifications_log: only fire if not yet executed for this
        // occurrence.
        const exists = await sb.from("notifications_log")
          .select("id")
          .eq("entity_type", "planned_payment")
          .eq("entity_id", p.id)
          .eq("event_key", `auto_executed_${p.next_due_date}`)
          .maybeSingle();
        if (!exists.data) {
          const expIns = await sb.from("expenses").insert({
            kind: p.kind,
            name: p.name,
            expense_date: p.next_due_date,
            amount: p.amount,
            currency: p.currency,
            amount_pln: p.currency === "PLN" ? p.amount : p.amount,
            category_id: p.category_id,
            family_member_id: p.family_member_id,
            source: "text",
            payment_method: p.payment_method,
            description: `Auto: planned payment "${p.name}"`,
          });
          if (!expIns.error) {
            await sb.from("notifications_log").insert({
              entity_type: "planned_payment",
              entity_id: p.id,
              event_key: `auto_executed_${p.next_due_date}`,
              family_member_id: p.family_member_id,
            });
            stats.planned_auto_executed++;
            await notifyUser(
              m.telegram_id,
              `✅ Авто-проведено: ${verb} «${p.name}» ${sign}${
                formatAmount(p.amount, p.currency)
              } (${cat ?? "категория не задана"})`,
            );
          } else {
            log("warn", "planned_auto_execute_failed", {
              id: p.id,
              error: expIns.error.message,
            });
          }
        }
      }

      // Advance next_due_date past today regardless of auto_confirm
      // (reminder fired or auto-exec ran). For 'once', mark inactive.
      const patch: Record<string, unknown> = p.frequency === "once"
        ? { active: false, last_executed_date: today }
        : {
          next_due_date: advanceDate(p.next_due_date, p.frequency),
          last_executed_date: today,
        };
      await sb.from("planned_payments").update(patch).eq("id", p.id);
    }
  }

  // ---- Budgets --------------------------------------------------------
  const budgs = await sb.from("budgets")
    .select(
      "id, family_member_id, name, amount, currency, period, notify_on_exceed, notify_at_75, active",
    )
    .eq("active", true);
  const links = await sb.from("budget_categories").select("budget_id, category_id");
  const catsByBudget = new Map<string, string[]>();
  for (
    const l of (links.data ?? []) as Array<{ budget_id: string; category_id: string }>
  ) {
    const arr = catsByBudget.get(l.budget_id) ?? [];
    arr.push(l.category_id);
    catsByBudget.set(l.budget_id, arr);
  }
  for (const b of (budgs.data ?? []) as Budget[]) {
    const m = members.get(b.family_member_id);
    if (!m) continue;
    const catIds = catsByBudget.get(b.id) ?? [];
    if (catIds.length === 0) continue;
    const startIso = periodStart(b.period, today);
    const exp = await sb.from("expenses")
      .select("amount_pln")
      .eq("archived", false)
      .eq("kind", "expense")
      .in("category_id", catIds)
      .gte("expense_date", startIso)
      .lte("expense_date", today);
    let spentPln = 0;
    for (const r of (exp.data ?? []) as Array<{ amount_pln: number }>) {
      spentPln += Number(r.amount_pln) || 0;
    }
    const rate = await latestRate(sb, b.currency);
    const spentAmount = b.currency === "PLN" ? spentPln : spentPln / rate;
    const pct = b.amount > 0 ? (spentAmount / b.amount) * 100 : 0;
    const pkey = periodKey(b.period, today);

    if (b.notify_at_75 && pct >= 75 && pct < 100) {
      const ok = await sendOnce(
        sb,
        "budget",
        b.id,
        `budget_75_${pkey}`,
        m,
        `⚠️ Бюджет «${b.name}»: достигли ${Math.round(pct)}%\n` +
          `${formatAmount(spentAmount, b.currency)} из ${formatAmount(b.amount, b.currency)}`,
      );
      if (ok) stats.budget_75++;
    }
    if (b.notify_on_exceed && pct >= 100) {
      const ok = await sendOnce(
        sb,
        "budget",
        b.id,
        `budget_exceed_${pkey}`,
        m,
        `🚨 Бюджет «${b.name}» превышен: ${Math.round(pct)}%\n` +
          `${formatAmount(spentAmount, b.currency)} из ${formatAmount(b.amount, b.currency)}`,
      );
      if (ok) stats.budget_over++;
    }
  }

  // ---- Debts ----------------------------------------------------------
  const dbts = await sb.from("debts")
    .select(
      "id, family_member_id, direction, counterparty, amount, currency, remaining_balance, due_date, notify_3d_before, notify_on_due, notify_overdue, status",
    )
    .eq("status", "active");
  for (const d of (dbts.data ?? []) as Debt[]) {
    const m = members.get(d.family_member_id);
    if (!m || !d.due_date) continue;
    const daysLeft = diffDays(d.due_date, today);
    const owesYou = d.direction === "owed_to_me";
    const tag = owesYou ? "Должны мне" : "Должен я";

    if (d.notify_3d_before && daysLeft === 3) {
      const ok = await sendOnce(
        sb,
        "debt",
        d.id,
        "debt_3d",
        m,
        `📅 Через 3 дня срок долга (${tag}): ${d.counterparty} - ${
          formatAmount(d.remaining_balance, d.currency)
        }\nДата: ${d.due_date}`,
      );
      if (ok) stats.debt_3d++;
    }
    if (d.notify_on_due && daysLeft === 0) {
      const ok = await sendOnce(
        sb,
        "debt",
        d.id,
        "debt_due",
        m,
        `🔔 Сегодня срок долга (${tag}): ${d.counterparty} - ${
          formatAmount(d.remaining_balance, d.currency)
        }`,
      );
      if (ok) stats.debt_due++;
    }
    if (d.notify_overdue && daysLeft < 0) {
      const ok = await sendOnce(
        sb,
        "debt",
        d.id,
        "debt_overdue",
        m,
        `🚨 Просрочка долга (${tag}): ${d.counterparty} - ${
          formatAmount(d.remaining_balance, d.currency)
        }\nСрок был: ${d.due_date} (${-daysLeft} дн. назад)`,
      );
      if (ok) {
        stats.debt_overdue++;
        await sb.from("debts").update({ status: "overdue" }).eq("id", d.id);
      }
    }
  }

  log("info", "notifications_done", { today, ...stats });
  return Response.json({ today, ...stats });
});
