// Pure command handlers for tg-webhook. Tested independently of grammy.
//
// Each function returns the reply text (or an object with text + inline
// keyboard markup) given a FamilyMember context and the supabase client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { recordAudit } from "../_shared/audit.ts";
import { notifyUser } from "../_shared/notify.ts";
import { buildAnalystSnapshot } from "../_shared/analyst_snapshot.ts";
import { buildAskPrompt } from "../_shared/prompts/ask.ts";
import { callClaude } from "../_shared/claude.ts";
import { type AskTurn, runAskAgent } from "../_shared/ask_agent.ts";

const WEBAPP_URL_FALLBACK = "https://kompaniy12-creator.github.io/finbot/";

export interface ReplyKeyboardButton {
  text: string;
  web_app?: { url: string };
}

export interface CommandReply {
  text: string;
  reply_markup?: { inline_keyboard: ReplyKeyboardButton[][] };
  // Optional callback fired by the webhook after the reply is sent and the
  // bot's message_id is known. Used by /ask to persist the thread state so
  // a follow-up Telegram "reply" can find the conversation.
  onSent?: (messageId: number) => Promise<void>;
}

export function startCommand(member: FamilyMember): CommandReply {
  return {
    text: [
      `Привет, ${member.name}. Это FinBot, твой личный финансовый помощник.`,
      "",
      "Можно делать две вещи:",
      "• записывать траты - текстом, голосом или фото чека (например: «кофе 12 zł»)",
      "• разговаривать со мной как с финансовым консультантом - спрашивай, советуйся, проси посчитать или поправить (например: «на что я больше всего трачу?», «сколько ушло на еду в мае?»)",
      "",
      "Чтобы продолжить беседу - ответь (reply) на моё сообщение.",
      "",
      "Команды:",
      "/help - справка",
      "/dashboard - открыть дашборд",
      "/history - последние траты",
      "/stats - сводка за месяц",
    ].join("\n"),
  };
}

export function helpCommand(member: FamilyMember): CommandReply {
  // Avoid '<' and '>' in this text - sendMessage uses parse_mode=HTML and any
  // unknown tag like <tid> causes Telegram to reject the entire message.
  const adminOnly = member.role === "admin"
    ? [
      "",
      "",
      "Для админа:",
      "/health - статус системы",
      "/audit ID - история изменений траты",
      "/budget - бюджет Anthropic",
      "/members - кто имеет доступ",
      "/grant TID [имя] - дать доступ",
      "/revoke TID - отозвать доступ",
      "/promote TID - сделать админом",
      "/demote TID - снять админа",
      "/subscriptions - найти подписки и добавить в регулярные",
    ].join("\n")
    : "";
  return {
    text: [
      "Что я умею:",
      "",
      "• Записывать траты - пиши текстом, голосом или присылай фото чека.",
      "  Пример: «кофе 12 zł и бензин 150 zł».",
      "",
      "• Общаться как личный финансист - просто задай вопрос или попроси что-то.",
      "  Пример: «сколько потратил на еду в мае?», «удали последнюю запись», «покажи топ категорий».",
      "  Чтобы продолжить беседу - ответь (reply) на моё сообщение.",
      "",
      "Команды:",
      "/start - приветствие",
      "/help - эта справка",
      "/categories - список категорий",
      "/dashboard - открыть дашборд",
      "/web - получить ссылку на дашборд для браузера на компе",
      "/web_logout - отозвать все браузерные сессии",
      "/history - последние траты",
      "/stats - сводка за месяц (вся семья)",
      "/me - моя статистика за месяц",
      "/ask ВОПРОС - то же, что просто написать вопрос",
      "/undo - отменить последнюю",
      "/recurring - регулярные траты",
    ].join("\n") + adminOnly,
  };
}

export async function categoriesCommand(
  sb: SupabaseClient,
  tenantId: string,
): Promise<CommandReply> {
  const db = tenantDb(sb, tenantId);
  const { data, error } = await db.from("categories")
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

const MAGIC_TTL_MIN = 5;
const WEB_RATE_LIMIT_PER_5MIN = 3;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// /web - issues a one-time magic link the user opens in a regular browser.
// The link expires after 5 minutes and can only be exchanged once. On the
// browser side, ?magic=<token> hits api-web-exchange which trades it for a
// 24-hour session token stored in localStorage.
export async function webCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, member.tenant_id);
  // Soft per-user rate limit: 3 magic links per 5 minutes. We count
  // unconsumed-and-still-valid rows; deliberately permissive so a user who
  // refreshed and tossed a tab can ask again.
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recent = await db.from("web_sessions")
    .select("id", { count: "exact", head: true })
    .eq("family_member_id", member.id)
    .gte("created_at", since);
  if ((recent.count ?? 0) >= WEB_RATE_LIMIT_PER_5MIN) {
    return {
      text: "Слишком много запросов ссылок подряд. Подожди 5 минут и попробуй снова, " +
        "или используй уже выданную ссылку (живёт 5 минут).",
    };
  }

  const magic = randomHex(32);
  const magicExpiresAt = new Date(
    Date.now() + MAGIC_TTL_MIN * 60 * 1000,
  ).toISOString();
  const ins = await db.from("web_sessions").insert({
    family_member_id: member.id,
    magic_token: magic,
    magic_expires_at: magicExpiresAt,
  });
  if (ins.error) {
    return { text: `Не смог создать ссылку: ${ins.error.message}` };
  }

  const base = Deno.env.get("WEBAPP_URL") ?? WEBAPP_URL_FALLBACK;
  // Strip a trailing slash to avoid `//` and any existing query.
  const clean = base.replace(/\/+$/, "").split("?")[0];
  const url = `${clean}/?magic=${magic}`;

  return {
    text: [
      `Открой эту ссылку в браузере на компе - она залогинит тебя на 24 часа:`,
      "",
      url,
      "",
      `Ссылка действует 5 минут и работает один раз.`,
      `Если что-то пойдёт не так - вызови /web ещё раз.`,
      `Чтобы отозвать все активные сессии в браузерах - /web_logout.`,
    ].join("\n"),
  };
}

// /web_logout - invalidates every active web session for the caller, so a
// lost laptop can't keep reading the data. Doesn't touch Telegram auth.
export async function webLogoutCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, member.tenant_id);
  const upd = await db.from("web_sessions")
    .update({ session_expires_at: new Date(0).toISOString() })
    .eq("family_member_id", member.id)
    .gt("session_expires_at", new Date().toISOString());
  if (upd.error) {
    return { text: `Ошибка отзыва: ${upd.error.message}` };
  }
  return {
    text: "Все активные браузерные сессии отозваны. Чтобы войти заново - /web.",
  };
}

export async function healthCommand(
  sb: SupabaseClient,
  tenantId: string,
): Promise<CommandReply> {
  const db = tenantDb(sb, tenantId);
  const sh = await sb
    .from("system_health")
    .select("last_seen, bot_version, backup_key_confirmed")
    .eq("id", 1)
    .maybeSingle();
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayCount = await db.from("expenses")
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
  tenantId: string,
  expenseId: string,
): Promise<CommandReply> {
  const db = tenantDb(sb, tenantId);
  if (!/^[0-9a-f-]{36}$/i.test(expenseId)) {
    return { text: "Использование: /audit UUID" };
  }
  const { data, error } = await db.from("expense_audit")
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
    text: "Этот бот: личная собственность @the_kompanii . Свяжитесь с ним для получения доступа.",
  };
}

export async function membersCommand(
  sb: SupabaseClient,
  actor: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, actor.tenant_id);
  const res = await db.from("family_members")
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

  // NOTE: keep the footer free of '<' and '>' characters - sendMessage is
  // called with parse_mode=HTML, so /grant &lt;telegram_id&gt; entity parsing
  // would fail and Telegram silently drops the whole message.
  const footer = isAdmin
    ? "Жми на кнопку под именем чтобы изменить. Также работают команды: /grant TID [имя], /revoke TID, /promote TID, /demote TID."
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
  const db = tenantDb(sb, actor.tenant_id);
  const m = args.trim().match(/^(\d{4,})(?:\s+(.+))?$/);
  if (!m) {
    return {
      text: "Использование: /grant TID [имя]\nПример: /grant 326628865 Den",
    };
  }
  const tid = Number(m[1]);
  const name = (m[2] ?? "Member").trim().slice(0, 80) || "Member";

  const existing = await db.from("family_members")
    .select("id, name, role, active")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (existing.error) return { text: `DB error: ${existing.error.message}` };

  if (existing.data) {
    const row = existing.data as { id: string; name: string; role: string; active: boolean };
    if (row.active) {
      return { text: `${row.name} (${tid}) уже имеет доступ (${row.role}).` };
    }
    const upd = await db.from("family_members").update({ active: true }).eq("id", row.id);
    if (upd.error) return { text: `DB error: ${upd.error.message}` };
    await recordAudit(sb, {
      actorTelegramId: actor.telegram_id,
      actorFamilyMemberId: actor.id,
      action: "member_reactivated",
      targetId: row.id,
      targetName: row.name,
      details: { telegram_id: tid, role: row.role },
    });
    await notifyUser(
      tid,
      `✅ Доступ к FinBot восстановлен. ${row.name}, можешь снова пользоваться ботом.`,
    );
    return { text: `✅ Доступ восстановлен: ${row.name} (${tid}).` };
  }

  const ins = await db.from("family_members").insert({
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
  await notifyUser(
    tid,
    `✅ Доступ к FinBot предоставлен. Привет, ${name}! Напиши /start чтобы начать.`,
  );
  return { text: `✅ Добавлен: ${name} (${tid}). Он может сразу пользоваться ботом.` };
}

export async function revokeCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, actor.tenant_id);
  const tid = Number(args.trim());
  if (!tid || !Number.isInteger(tid)) {
    return { text: "Использование: /revoke TID" };
  }
  if (tid === actor.telegram_id) {
    return { text: "Нельзя отозвать доступ у самого себя." };
  }
  const row = await db.from("family_members")
    .select("id, name, active")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (row.error) return { text: `DB error: ${row.error.message}` };
  const m = row.data as { id: string; name: string; active: boolean } | null;
  if (!m) return { text: `Не нашёл участника с telegram_id=${tid}.` };
  if (!m.active) return { text: `${m.name} уже отключен.` };
  const upd = await db.from("family_members").update({ active: false }).eq("id", m.id);
  if (upd.error) return { text: `DB error: ${upd.error.message}` };
  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "member_revoked",
    targetId: m.id,
    targetName: m.name,
    details: { telegram_id: tid },
  });
  await notifyUser(tid, "🚫 Ваш доступ к FinBot отозван администратором.");
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
  const db = tenantDb(sb, actor.tenant_id);
  const tid = Number(args.trim());
  if (!tid || !Number.isInteger(tid)) {
    return { text: `Использование: /${newRole === "admin" ? "promote" : "demote"} TID` };
  }
  const row = await db.from("family_members")
    .select("id, name, role")
    .eq("telegram_id", tid)
    .maybeSingle();
  if (row.error) return { text: `DB error: ${row.error.message}` };
  const m = row.data as { id: string; name: string; role: string } | null;
  if (!m) return { text: `Не нашёл участника с telegram_id=${tid}.` };
  if (m.role === newRole) return { text: `${m.name} уже ${newRole}.` };
  const upd = await db.from("family_members").update({ role: newRole }).eq("id", m.id);
  if (upd.error) return { text: `DB error: ${upd.error.message}` };
  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: newRole === "admin" ? "member_promoted" : "member_demoted",
    targetId: m.id,
    targetName: m.name,
    details: { telegram_id: tid, from_role: m.role, to_role: newRole },
  });
  await notifyUser(
    tid,
    newRole === "admin"
      ? "⭐ Тебе выдана роль администратора FinBot."
      : "ℹ Роль администратора снята. Доступ к боту сохранён.",
  );
  const verb = newRole === "admin" ? "повышен до админа" : "понижен до участника";
  return { text: `✅ ${m.name} ${verb}.` };
}

// Generate a short, human-friendly invite code (no ambiguous chars).
function genInviteCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return "FB-" + s;
}

// /mint_invite [N] - admin only. Creates N single-use invite codes for the SaaS
// bot and returns them. invite_codes is a global table (not per-tenant).
export async function mintInviteCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const n = Math.min(Math.max(parseInt(args.trim(), 10) || 1, 1), 10);
  const codes = Array.from({ length: n }, genInviteCode);
  const rows = codes.map((code) => ({
    code,
    created_by_telegram_id: actor.telegram_id,
    max_uses: 1,
  }));
  const ins = await sb.from("invite_codes").insert(rows);
  if (ins.error) {
    return { text: `Не смог создать коды: ${ins.error.message}` };
  }
  return {
    text: `🎟 ${n === 1 ? "Код приглашения" : `Коды приглашения (${n})`} ` +
      `для публичного бота (по одному использованию):\n\n` +
      codes.map((c) => `<code>${c}</code>`).join("\n") +
      `\n\nОтдай тестеру: пусть напишет публичному боту <code>/start КОД</code>.`,
  };
}

// /apikey <key> - the tester stores their own Anthropic key so their AI usage
// is billed to them, not the owner. Stored on tenants.anthropic_api_key.
export async function apiKeyCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const key = args.trim();
  if (!key.startsWith("sk-ant-")) {
    return {
      text: "Это не похоже на ключ Anthropic (он начинается с <code>sk-ant-</code>).\n" +
        "Получи его на https://console.anthropic.com/settings/keys и пришли:\n" +
        "<code>/apikey sk-ant-...</code>",
    };
  }
  const upd = await sb.from("tenants").update({ anthropic_api_key: key })
    .eq("id", actor.tenant_id);
  if (upd.error) return { text: `Не смог сохранить ключ: ${upd.error.message}` };
  return {
    text: "✅ Ключ Anthropic сохранён. Теперь пиши траты - я их распознаю.\n\n" +
      "🔒 Совет: удали сообщение с ключом из чата (ключ уже сохранён).",
  };
}

// /groqkey <key> - the tester's own Groq key for voice transcription (Whisper).
// Stored on tenants.groq_api_key. Groq has a free tier.
export async function groqKeyCommand(
  sb: SupabaseClient,
  args: string,
  actor: FamilyMember,
): Promise<CommandReply> {
  const key = args.trim();
  if (!key.startsWith("gsk_")) {
    return {
      text: "Это не похоже на ключ Groq (он начинается с <code>gsk_</code>).\n" +
        "Получи его бесплатно на https://console.groq.com/keys и пришли:\n" +
        "<code>/groqkey gsk_...</code>",
    };
  }
  const upd = await sb.from("tenants").update({ groq_api_key: key })
    .eq("id", actor.tenant_id);
  if (upd.error) return { text: `Не смог сохранить ключ: ${upd.error.message}` };
  return {
    text: "✅ Ключ Groq сохранён. Теперь можно слать голосовые.\n\n" +
      "🔒 Совет: удали сообщение с ключом из чата.",
  };
}

export function unsupportedReply(): CommandReply {
  return {
    text:
      "Пока умею только команды (/start, /help). Парсинг трат включается с M7. Возвращайся позже!",
  };
}

// Detect "subscription"-like spending patterns: same (family_member, name,
// currency, amount) repeated 3+ times in the last 120 days with roughly
// monthly cadence. Filter out anything already in recurring_expenses.
// Output a list with inline buttons to convert each into a recurring row.
export async function subscriptionsCommand(
  sb: SupabaseClient,
  actor: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, actor.tenant_id);
  if (actor.role !== "admin") return { text: "Только админ." };

  const sinceDate = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const res = await db.from("expenses")
    .select("id, name, amount, currency, category_id, family_member_id, expense_date")
    .eq("archived", false)
    .gte("expense_date", sinceDate)
    .order("expense_date", { ascending: false });
  if (res.error) return { text: `DB error: ${res.error.message}` };
  const rows = (res.data ?? []) as Array<{
    id: string;
    name: string;
    amount: number;
    currency: string;
    category_id: string;
    family_member_id: string;
    expense_date: string;
  }>;

  // Group by (family_member_id, lowercased name, currency, amount).
  interface Group {
    key: string;
    family_member_id: string;
    name: string;
    amount: number;
    currency: string;
    category_id: string;
    rows: typeof rows;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.family_member_id}|${r.name.toLowerCase().trim()}|${r.currency}|${r.amount}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        family_member_id: r.family_member_id,
        name: r.name,
        amount: Number(r.amount),
        currency: r.currency,
        category_id: r.category_id,
        rows: [],
      });
    }
    groups.get(key)!.rows.push(r);
  }

  // Candidate filter: 3+ occurrences AND cadence ~monthly (avg gap 20-40 days).
  const candidates: Group[] = [];
  for (const g of groups.values()) {
    if (g.rows.length < 3) continue;
    const dates = g.rows.map((r) => r.expense_date).sort();
    const firstMs = new Date(dates[0]! + "T00:00:00Z").getTime();
    const lastMs = new Date(dates[dates.length - 1]! + "T00:00:00Z").getTime();
    const spanDays = (lastMs - firstMs) / 86_400_000;
    const avgGap = spanDays / (g.rows.length - 1);
    if (avgGap < 20 || avgGap > 40) continue;
    candidates.push(g);
  }

  // Exclude ones already in recurring_expenses.
  const rec = await db.from("recurring_expenses")
    .select("name, currency, amount, family_member_id");
  const recSet = new Set(
    ((rec.data ?? []) as Array<{
      name: string;
      currency: string;
      amount: number;
      family_member_id: string;
    }>).map((r) =>
      `${r.family_member_id}|${r.name.toLowerCase().trim()}|${r.currency}|${Number(r.amount)}`
    ),
  );
  const fresh = candidates.filter((c) => !recSet.has(c.key));

  if (fresh.length === 0) {
    return {
      text:
        "Подписок не нашёл. Чтобы попасть в детектор, нужна повторяющаяся трата с тем же именем, валютой и суммой 3+ раз за последние 4 месяца.",
    };
  }

  // Build text + inline buttons (one button per candidate).
  fresh.sort((a, b) => b.rows.length - a.rows.length);
  const visible = fresh.slice(0, 10); // Telegram caps inline_keyboard, keep it sane
  const lines = visible.map((c, i) => {
    const lastDate = c.rows.map((r) => r.expense_date).sort().slice(-1)[0];
    return `${
      i + 1
    }. ${c.name} ${c.amount} ${c.currency} - ${c.rows.length} повторов, последний ${lastDate}`;
  });
  const buttons: Array<Array<{ text: string; callback_data: string }>> = visible.map((c) => [{
    text: `✅ ${c.name} ${c.amount} ${c.currency}`,
    callback_data: `subadd:${c.rows[0]!.id}`,
  }]);

  return {
    text: [
      `Похоже на подписки (${visible.length}):`,
      "",
      ...lines,
      "",
      "Тап на кнопку = добавить в регулярные траты.",
    ].join("\n"),
    reply_markup: { inline_keyboard: buttons } as CommandReply["reply_markup"],
  };
}

// Personal stats card. Unlike statsCommand (family-wide month total),
// /me returns the caller's own activity for the current month: their
// spend, top category, average per record, days with activity, and a
// share-of-family percentage.
export async function meCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, member.tenant_id);
  const tz = Deno.env.get("DEFAULT_TIMEZONE") ?? "Europe/Warsaw";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  });
  const ym = fmt.format(new Date());
  const monthStart = `${ym}-01`;

  const [mineRes, allRes, catRes] = await Promise.all([
    db.from("expenses")
      .select("amount, currency, amount_pln, category_id, expense_date")
      .eq("archived", false)
      .eq("kind", "expense")
      .eq("family_member_id", member.id)
      .gte("expense_date", monthStart),
    db.from("expenses")
      .select("amount_pln")
      .eq("archived", false)
      .eq("kind", "expense")
      .gte("expense_date", monthStart),
    db.from("categories").select("id, name"),
  ]);
  if (mineRes.error) return { text: `DB error: ${mineRes.error.message}` };

  const mine = (mineRes.data ?? []) as Array<{
    amount: number;
    currency: string;
    amount_pln: number;
    category_id: string;
    expense_date: string;
  }>;
  const all = (allRes.data ?? []) as Array<{ amount_pln: number }>;
  const catName = new Map(
    ((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  if (mine.length === 0) {
    return { text: `${member.name}, в этом месяце ещё нет твоих записей.` };
  }

  let totalPln = 0;
  const byCcy = new Map<string, number>();
  const byCat = new Map<string, number>();
  const days = new Set<string>();
  for (const r of mine) {
    totalPln += Number(r.amount_pln);
    byCcy.set(r.currency, (byCcy.get(r.currency) ?? 0) + Number(r.amount));
    byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + Number(r.amount_pln));
    days.add(r.expense_date);
  }
  const topCat = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  const avgPerRecord = totalPln / mine.length;
  const familyTotalPln = all.reduce((acc, r) => acc + Number(r.amount_pln), 0);
  const sharePct = familyTotalPln > 0 ? (totalPln / familyTotalPln) * 100 : 0;

  const ccyOrder = ["PLN", "EUR", "USD", "ALL"];
  const ccyLines = [...byCcy.entries()]
    .sort((a, b) => {
      const ia = ccyOrder.indexOf(a[0]);
      const ib = ccyOrder.indexOf(b[0]);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([c, v]) => `  ${c}: ${v.toFixed(2)}`);

  return {
    text: [
      `Привет, ${member.name}. Твоя статистика за ${ym}:`,
      "",
      `Записей: ${mine.length}`,
      `Активных дней: ${days.size}`,
      `Средний чек: ${avgPerRecord.toFixed(2)} PLN`,
      `Доля от семьи: ${sharePct.toFixed(1)}%`,
      "",
      "По валютам:",
      ...ccyLines,
      "",
      topCat
        ? `Топ-категория: ${catName.get(topCat[0]) ?? "?"} (${topCat[1].toFixed(2)} PLN)`
        : "Топ-категория: -",
    ].join("\n"),
  };
}

export async function historyCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, member.tenant_id);
  const scope = member.role === "admin" ? null : member.id;
  let q = db.from("expenses")
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
  const db = tenantDb(sb, member.tenant_id);
  const undoMin = Number(Deno.env.get("UNDO_WINDOW_MINUTES") ?? "10");
  const cutoff = new Date(Date.now() - undoMin * 60_000).toISOString();
  const r = await db.from("expenses")
    .select("id, name, created_at")
    .eq("family_member_id", member.id)
    .eq("archived", false)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = r.data as { id: string; name: string; created_at: string } | null;
  if (!row) return { text: `Нет записей за последние ${undoMin} минут для отмены.` };
  await db.from("expenses").update({ archived: true }).eq("id", row.id);
  return { text: `Отменено: ${row.name}` };
}

export async function statsCommand(
  sb: SupabaseClient,
  member: FamilyMember,
): Promise<CommandReply> {
  const db = tenantDb(sb, member.tenant_id);
  // First day of current Warsaw month, as ISO YYYY-MM-DD.
  const tz = Deno.env.get("DEFAULT_TIMEZONE") ?? "Europe/Warsaw";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  });
  const ym = fmt.format(new Date()); // "2026-05"
  const monthStart = `${ym}-01`;

  let q = db.from("expenses")
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
  const cats = await db.from("categories").select("id, name");
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

// Strip any Markdown the model might still emit despite the instruction.
function sanitizeAskText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1")
    .replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, "$1")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[<>]/g, "");
}

// Core /ask runner shared by /ask command and reply-continuation. Builds the
// reply AND attaches onSent that persists the new thread row so the next
// Telegram reply can find this conversation.
export async function runAskAndBuildReply(args: {
  sb: SupabaseClient;
  viewer: FamilyMember;
  chatId: number | null;
  question: string;
  priorTurns?: AskTurn[];
}): Promise<CommandReply> {
  const db = tenantDb(args.sb, args.viewer.tenant_id);
  const { sb, viewer, chatId, question, priorTurns } = args;

  let agentResult;
  try {
    agentResult = await runAskAgent({ sb, viewer, question, priorTurns });
  } catch (err) {
    return { text: `Ошибка аналитика: ${(err as Error).message}` };
  }

  const cleanText = sanitizeAskText(agentResult.text || "");
  const nextHistory: AskTurn[] = [
    ...(priorTurns ?? []),
    { question, answer: cleanText },
  ];

  // Cap stored history so a long chat doesn't blow up the row size.
  const trimmedHistory = nextHistory.slice(-8);

  const persistThread = (chatId === null) ? undefined : async (messageId: number) => {
    const ins = await db.from("ask_threads").insert({
      chat_id: chatId,
      bot_message_id: messageId,
      family_member_id: viewer.id,
      history: trimmedHistory,
    });
    if (ins.error) {
      // Non-fatal: thread storage failing just means follow-ups won't have
      // context. The user still got their answer.
      console.log(JSON.stringify({
        level: "error",
        event: "ask_thread_insert_failed",
        error: ins.error.message,
      }));
    }
  };

  if (agentResult.proposalId && agentResult.actionCount > 0) {
    // Show the proposal and inline confirm/cancel. Actual writes happen in
    // the askapply callback.
    return {
      text: `🤖 ${cleanText}\n\nПодтвердить ${agentResult.actionCount} ${
        agentResult.actionCount === 1 ? "действие" : "действий"
      }?`,
      reply_markup: {
        inline_keyboard: [[
          {
            text: `✅ Применить (${agentResult.actionCount})`,
            callback_data: `askapply:${agentResult.proposalId}`,
          },
          {
            text: "❌ Отмена",
            callback_data: `askcancel:${agentResult.proposalId}`,
          },
        ]],
      } as unknown as CommandReply["reply_markup"],
      onSent: persistThread,
    };
  }

  return { text: `🤖 ${cleanText}`, onSent: persistThread };
}

// /ask <question> -> personal financial analyst. Builds a snapshot of all
// the family's data and asks Claude Haiku to answer with that snapshot as
// the ONLY source of truth.
export async function askCommand(
  sb: SupabaseClient,
  question: string,
  viewer: FamilyMember,
  chatId?: number,
): Promise<CommandReply> {
  const q = (question || "").trim();
  if (!q) {
    return {
      text: [
        "Использование: /ask ВОПРОС",
        "",
        "Примеры:",
        "/ask сколько я потратил на еду в этом месяце",
        "/ask какая моя топ-категория за последние полгода",
        "/ask на сколько вырос расход в мае по сравнению с апрелем",
        "/ask какие у меня регулярные платежи",
        "",
        "Можно отвечать (reply) на мои сообщения, чтобы продолжить беседу.",
      ].join("\n"),
    };
  }
  if (q.length > 500) {
    return { text: "Слишком длинный вопрос (макс 500 символов). Попробуй короче." };
  }

  // Keep historical imports alive (used to belong to the pre-agent flow).
  void buildAskPrompt;
  void buildAnalystSnapshot;
  void callClaude;

  return await runAskAndBuildReply({
    sb,
    viewer,
    chatId: chatId ?? null,
    question: q,
  });
}
