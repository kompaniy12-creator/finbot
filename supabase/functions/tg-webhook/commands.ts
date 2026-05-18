// Pure command handlers for tg-webhook. Tested independently of grammy.
//
// Each function returns the reply text (or an object with text + inline
// keyboard markup) given a FamilyMember context and the supabase client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";

const WEBAPP_URL_FALLBACK = "https://kompaniy12-creator.github.io/finbot/webapp/";

export interface ReplyKeyboardButton {
  text: string;
  web_app?: { url: string };
}

export interface CommandReply {
  text: string;
  reply_markup?: { inline_keyboard: ReplyKeyboardButton[][] };
}

export function startCommand(member: FamilyMember): CommandReply {
  return {
    text: [
      `Привет, ${member.name}. Это FinBot.`,
      "",
      "Просто пиши, что потратил, можно текстом, голосом или фото чека. Я разберу.",
      "",
      "Команды:",
      "/help - справка",
      "/categories - 17 категорий",
      "/dashboard - открыть дашборд",
      "/history - последние траты (M7)",
      "/stats - сводка за месяц (M7)",
    ].join("\n"),
  };
}

export function helpCommand(member: FamilyMember): CommandReply {
  const adminOnly = member.role === "admin"
    ? "\n\nДля админа:\n/health - статус системы\n/audit <id> - история изменений траты\n/budget - бюджет Anthropic"
    : "";
  return {
    text: [
      "Команды FinBot:",
      "",
      "/start - приветствие",
      "/help - эта справка",
      "/categories - список из 17 категорий",
      "/dashboard - открыть дашборд",
      "/history - последние траты (с M7)",
      "/stats - сводка за месяц (с M7)",
      "/undo - отменить последнюю (с M7)",
      "/recurring - регулярные траты (с M14)",
    ].join("\n") + adminOnly,
  };
}

export async function categoriesCommand(
  sb: SupabaseClient,
): Promise<CommandReply> {
  const { data, error } = await sb
    .from("categories")
    .select("name, is_fallback")
    .order("is_fallback", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    return { text: `Ошибка получения категорий: ${error.message}` };
  }
  const lines = (data as Array<{ name: string; is_fallback: boolean }>).map(
    (c, i) => `${i + 1}. ${c.name}${c.is_fallback ? " (fallback)" : ""}`,
  );
  return {
    text: `Категории (${lines.length}):\n\n${lines.join("\n")}`,
  };
}

export function dashboardCommand(): CommandReply {
  const url = Deno.env.get("WEBAPP_URL") ?? WEBAPP_URL_FALLBACK;
  return {
    text: "Открой дашборд:",
    reply_markup: {
      inline_keyboard: [[{ text: "Дашборд", web_app: { url } }]],
    },
  };
}

export async function healthCommand(
  sb: SupabaseClient,
): Promise<CommandReply> {
  const sh = await sb
    .from("system_health")
    .select("last_seen, bot_version, backup_key_confirmed")
    .eq("id", 1)
    .maybeSingle();
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayCount = await sb
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("expense_date", todayIso);

  if (sh.error) {
    return { text: `Health DB error: ${sh.error.message}` };
  }
  const h = sh.data as {
    last_seen: string;
    bot_version: string | null;
    backup_key_confirmed: boolean;
  } | null;

  return {
    text: [
      "Health",
      "",
      `last_seen: ${h?.last_seen ?? "(none)"}`,
      `version: ${h?.bot_version ?? "(unset)"}`,
      `backup_confirmed: ${h?.backup_key_confirmed ?? false}`,
      `expenses today: ${todayCount.count ?? 0}`,
    ].join("\n"),
  };
}

export async function auditCommand(
  sb: SupabaseClient,
  expenseId: string,
): Promise<CommandReply> {
  if (!/^[0-9a-f-]{36}$/i.test(expenseId)) {
    return { text: "Использование: /audit <uuid>" };
  }
  const { data, error } = await sb
    .from("expense_audit")
    .select("action, created_at, actor_telegram_id, source")
    .eq("expense_id", expenseId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    return { text: `Audit DB error: ${error.message}` };
  }
  const rows = data as Array<{
    action: string;
    created_at: string;
    actor_telegram_id: number | null;
    source: string | null;
  }>;
  if (rows.length === 0) {
    return { text: `Нет audit-записей для ${expenseId}` };
  }
  return {
    text: [
      `Audit для ${expenseId.slice(0, 8)}...`,
      "",
      ...rows.map((r) =>
        `${r.created_at} ${r.action} actor=${r.actor_telegram_id ?? "system"} src=${
          r.source ?? "-"
        }`
      ),
    ].join("\n"),
  };
}

export function unauthorizedReply(): CommandReply {
  return {
    text: "Этот бот доступен только семье. Если ты семья и видишь это, свяжись с админом.",
  };
}

export function unsupportedReply(): CommandReply {
  return {
    text:
      "Пока умею только команды (/start, /help). Парсинг трат включается с M7. Возвращайся позже!",
  };
}

export async function historyCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const scope = member.role === "admin" ? null : member.id;
  let q = sb
    .from("expenses")
    .select("id, name, amount, currency, expense_date, category_id, created_at")
    .eq("archived", false)
    .order("created_at", { ascending: false })
    .limit(10);
  if (scope) q = q.eq("family_member_id", scope);
  const res = await q;
  if (res.error) return { text: `History DB error: ${res.error.message}` };
  const rows = (res.data ?? []) as Array<{
    id: string;
    name: string;
    amount: number;
    currency: string;
    expense_date: string;
  }>;
  if (rows.length === 0) return { text: "Пока нет записей." };
  return {
    text: [
      `Последние ${rows.length} ${member.role === "admin" ? "(вся семья)" : "(твои)"}:`,
      "",
      ...rows.map((r) => `- ${r.expense_date} ${r.amount} ${r.currency} ${r.name}`),
    ].join("\n"),
  };
}

export async function undoCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const undoMin = Number(Deno.env.get("UNDO_WINDOW_MINUTES") ?? "10");
  const cutoff = new Date(Date.now() - undoMin * 60_000).toISOString();
  const r = await sb
    .from("expenses")
    .select("id, name, created_at")
    .eq("family_member_id", member.id)
    .eq("archived", false)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = r.data as { id: string; name: string; created_at: string } | null;
  if (!row) return { text: `Нет записей за последние ${undoMin} минут для отмены.` };
  await sb.from("expenses").update({ archived: true }).eq("id", row.id);
  return { text: `Отменено: ${row.name}` };
}

export async function statsCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  // First day of current Warsaw month, as ISO YYYY-MM-DD.
  const tz = Deno.env.get("DEFAULT_TIMEZONE") ?? "Europe/Warsaw";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  });
  const ym = fmt.format(new Date()); // "2026-05"
  const monthStart = `${ym}-01`;

  let q = sb
    .from("expenses")
    .select("amount_pln, category_id")
    .eq("archived", false)
    .gte("expense_date", monthStart);
  if (member.role !== "admin") q = q.eq("family_member_id", member.id);
  const res = await q;
  if (res.error) return { text: `Stats DB error: ${res.error.message}` };
  const rows = (res.data ?? []) as Array<{ amount_pln: number; category_id: string }>;
  const byCat = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const v = Number(r.amount_pln);
    total += v;
    byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + v);
  }
  if (rows.length === 0) {
    return { text: `Нет трат в ${ym}.` };
  }
  const cats = await sb.from("categories").select("id, name");
  const catName = new Map<string, string>(
    ((cats.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  const lines = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => `- ${catName.get(id) ?? "?"}: ${v.toFixed(2)} PLN`);
  return {
    text: [
      `Статистика ${ym} ${member.role === "admin" ? "(вся семья)" : "(твоя)"}:`,
      "",
      ...lines,
      "",
      `Всего: ${total.toFixed(2)} PLN`,
    ].join("\n"),
  };
}
