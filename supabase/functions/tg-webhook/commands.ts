// Pure command handlers for tg-webhook. Tested independently of grammy.
//
// Each function returns the reply text (or an object with text + inline
// keyboard markup) given a FamilyMember context and the supabase client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { recordAudit } from "../_shared/audit.ts";

const WEBAPP_URL_FALLBACK = "https://kompaniy12-creator.github.io/finbot/";

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
    ? [
      "",
      "",
      "Для админа:",
      "/health - статус системы",
      "/audit <id> - история изменений траты",
      "/budget - бюджет Anthropic",
      "/members - кто имеет доступ",
      "/grant <tid> [имя] - дать доступ",
      "/revoke <tid> - отозвать доступ",
      "/promote <tid> - сделать админом",
      "/demote <tid> - снять админа",
    ].join("\n")
    : "";
  return {
    text: [
      "Команды FinBot:",
      "",
      "/start - приветствие",
      "/help - эта справка",
      "/categories - список категорий",
      "/dashboard - открыть дашборд",
      "/history - последние траты",
      "/stats - сводка за месяц",
      "/undo - отменить последнюю",
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
    text: "Этот бот: личная собственность @mr_kompanii . Свяжитесь с ним для получения доступа.",
  };
}

export async function membersCommand(
  sb: SupabaseClient,
  actor?: FamilyMember,
): Promise<CommandReply> {
  const res = await sb
    .from("family_members")
    .select("id, name, telegram_id, role, active, username")
    .order("active", { ascending: false })
    .order("role", { ascending: true })
    .order("name", { ascending: true });
  if (res.error) return { text: `DB error: ${res.error.message}` };
  const rows = (res.data ?? []) as Array<{
    id: string;
    name: string;
    telegram_id: number;
    role: string;
    active: boolean;
    username: string | null;
  }>;
  if (rows.length === 0) return { text: "Список пуст." };
  const lines = rows.map((r) => {
    const status = r.active ? "" : " (отключен)";
    const tag = r.username ? ` @${r.username}` : "";
    const role = r.role === "admin" ? " ⭐" : "";
    return `- ${r.name}${tag} [${r.telegram_id}]${role}${status}`;
  });

  // Build inline action buttons (admin only). For each member that is NOT the
  // actor: revoke + promote-or-demote when active; reactivate when inactive.
  // Self gets no buttons so admin can't lock themselves out.
  const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];
  const isAdmin = actor?.role === "admin";
  if (isAdmin) {
    for (const r of rows) {
      if (r.telegram_id === actor.telegram_id) continue;
      const row: Array<{ text: string; callback_data: string }> = [];
      if (r.active) {
        row.push({ text: `🚫 Отозвать ${r.name}`, callback_data: `mrev:${r.id}` });
        if (r.role === "admin") {
          row.push({ text: `⬇ Снять админа`, callback_data: `mdemo:${r.id}` });
        } else {
          row.push({ text: `⭐ В админы`, callback_data: `mpromo:${r.id}` });
        }
      } else {
        row.push({ text: `✅ Восстановить ${r.name}`, callback_data: `mact:${r.id}` });
      }
      inlineRows.push(row);
    }
  }

  const footer = isAdmin
    ? "Жми на кнопку под именем чтобы изменить. Также работают команды: /grant <telegram_id> [имя], /revoke, /promote, /demote."
    : "Управление: только админ может менять состав.";

  const reply: CommandReply = {
    text: [`Участники (${rows.length}):`, "", ...lines, "", footer].join("\n"),
  };
  if (inlineRows.length > 0) {
    reply.reply_markup = { inline_keyboard: inlineRows } as CommandReply["reply_markup"];
  }
  return reply;
}

export async function grantCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const m = args.trim().match(/^(\d{4,})(?:\s+(.+))?$/);
  if (!m) {
    return {
      text: "Использование: /grant <telegram_id> [имя]\nПример: /grant 326628865 Den",
    };
  }
  const tid = Number(m[1]);
  const name = (m[2] ?? "Member").trim().slice(0, 80) || "Member";

  const existing = await sb
    .from("family_members")
    .select("id, name, role, active")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (existing.error) return { text: `DB error: ${existing.error.message}` };

  if (existing.data) {
    const row = existing.data as { id: string; name: string; role: string; active: boolean };
    if (row.active) {
      return { text: `${row.name} (${tid}) уже имеет доступ (${row.role}).` };
    }
    const upd = await sb.from("family_members").update({ active: true }).eq("id", row.id);
    if (upd.error) return { text: `DB error: ${upd.error.message}` };
    await recordAudit(sb, {
      actorTelegramId: actor.telegram_id,
      actorFamilyMemberId: actor.id,
      action: "member_reactivated",
      targetId: row.id,
      targetName: row.name,
      details: { telegram_id: tid, role: row.role },
    });
    return { text: `✅ Доступ восстановлен: ${row.name} (${tid}).` };
  }

  const ins = await sb.from("family_members").insert({
    name,
    telegram_id: tid,
    role: "member",
    active: true,
  }).select("id").maybeSingle();
  if (ins.error) return { text: `DB error: ${ins.error.message}` };
  const newId = (ins.data as { id: string } | null)?.id ?? null;
  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "member_granted",
    targetId: newId,
    targetName: name,
    details: { telegram_id: tid, role: "member" },
  });
  return { text: `✅ Добавлен: ${name} (${tid}). Он может сразу пользоваться ботом.` };
}

export async function revokeCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const tid = Number(args.trim());
  if (!tid || !Number.isInteger(tid)) {
    return { text: "Использование: /revoke <telegram_id>" };
  }
  if (tid === actor.telegram_id) {
    return { text: "Нельзя отозвать доступ у самого себя." };
  }
  const row = await sb
    .from("family_members")
    .select("id, name, active")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (row.error) return { text: `DB error: ${row.error.message}` };
  const m = row.data as { id: string; name: string; active: boolean } | null;
  if (!m) return { text: `Не нашёл участника с telegram_id=${tid}.` };
  if (!m.active) return { text: `${m.name} уже отключен.` };
  const upd = await sb.from("family_members").update({ active: false }).eq("id", m.id);
  if (upd.error) return { text: `DB error: ${upd.error.message}` };
  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "member_revoked",
    targetId: m.id,
    targetName: m.name,
    details: { telegram_id: tid },
  });
  return { text: `🚫 Доступ отозван: ${m.name} (${tid}).` };
}

export async function promoteCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  return await changeRoleCommand(sb, args, "admin", actor);
}

export async function demoteCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const tid = Number(args.trim());
  if (tid === actor.telegram_id) {
    return { text: "Нельзя снять с себя роль админа (нужен хотя бы один админ)." };
  }
  return await changeRoleCommand(sb, args, "member", actor);
}

async function changeRoleCommand(
  sb: SupabaseClient,
  args: string,
  newRole: "admin" | "member",
  actor: FamilyMember,
): Promise<CommandReply> {
  const tid = Number(args.trim());
  if (!tid || !Number.isInteger(tid)) {
    return { text: `Использование: /${newRole === "admin" ? "promote" : "demote"} <telegram_id>` };
  }
  const row = await sb
    .from("family_members")
    .select("id, name, role")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (row.error) return { text: `DB error: ${row.error.message}` };
  const m = row.data as { id: string; name: string; role: string } | null;
  if (!m) return { text: `Не нашёл участника с telegram_id=${tid}.` };
  if (m.role === newRole) return { text: `${m.name} уже ${newRole}.` };
  const upd = await sb.from("family_members").update({ role: newRole }).eq("id", m.id);
  if (upd.error) return { text: `DB error: ${upd.error.message}` };
  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: newRole === "admin" ? "member_promoted" : "member_demoted",
    targetId: m.id,
    targetName: m.name,
    details: { telegram_id: tid, from_role: m.role, to_role: newRole },
  });
  const verb = newRole === "admin" ? "повышен до админа" : "понижен до участника";
  return { text: `✅ ${m.name} ${verb}.` };
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
