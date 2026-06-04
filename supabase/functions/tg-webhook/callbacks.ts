// Inline-keyboard callback handlers for tg-webhook.
// Callback data uses a colon-separated tag format. Telegram caps callback_data
// at 64 bytes per button, so the category id is shortened to its first 8 hex
// chars (resolved server-side from the 24-row categories table).
//   undo:<expense_id>
//   catmenu:<expense_id>            - show top categories
//   catall:<expense_id>:<page>      - paginate over all categories
//   catset:<expense_id>:<cat_prefix8> - change category + mark corrected_by_user
//   access_grant:<telegram_id>      - admin approves a pending access request
//   access_deny:<telegram_id>       - admin rejects a pending access request
//   mrev:<member_uuid>              - revoke (active=false)
//   mact:<member_uuid>              - reactivate (active=true)
//   mpromo:<member_uuid>            - promote to admin
//   mdemo:<member_uuid>             - demote to member
//   subadd:<expense_uuid>           - add a detected subscription to recurring_expenses
//   askapply:<proposal_uuid>        - execute the queued ask-agent proposal
//   askcancel:<proposal_uuid>       - mark the proposal cancelled
//
// Byte-budget sanity check:
//   "catset:" (7) + uuid (36) + ":" (1) + 8 = 52 bytes <= 64. OK.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { type CommandReply, membersCommand } from "./commands.ts";
import { retrainCategory } from "../_shared/retrain.ts";
import { log } from "../_shared/log.ts";
import { recordAudit } from "../_shared/audit.ts";
import { notifyUser } from "../_shared/notify.ts";

const UNDO_WINDOW_MIN = Number(Deno.env.get("UNDO_WINDOW_MINUTES") ?? "10");
const CAT_MENU_PAGE = 5;

export interface CallbackOutput {
  chatId: number;
  reply: CommandReply;
  /** When set, edit this message in place instead of sending a new one. */
  edit_message_id?: number;
  answer_text?: string;
}

interface ExpenseRow {
  id: string;
  family_member_id: string;
  created_at: string;
  archived: boolean;
  category_id: string;
}

function parseCallback(data: string): { kind: string; parts: string[] } | null {
  if (!data) return null;
  const parts = data.split(":");
  return { kind: parts[0]!, parts: parts.slice(1) };
}

export async function handleCallback(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  data: string;
  chatId: number;
  /** Telegram message_id of the bubble that carried the buttons (for edit-in-place). */
  messageId?: number;
}): Promise<CallbackOutput> {
  const cb = parseCallback(args.data);
  if (!cb) {
    return { chatId: args.chatId, reply: { text: "Неизвестный callback." } };
  }

  switch (cb.kind) {
    case "undo":
      return await doUndo(args.sb, args.member, args.chatId, cb.parts[0]!, args.messageId);
    case "catmenu":
      return await doCatMenu(args.sb, args.chatId, cb.parts[0]!, 0, args.messageId);
    case "catall": {
      const page = Number(cb.parts[1] ?? "0");
      return await doCatMenu(args.sb, args.chatId, cb.parts[0]!, page, args.messageId);
    }
    case "catset":
      return await doCatSet(args.sb, args.chatId, cb.parts[0]!, cb.parts[1]!, args.messageId);
    case "conf_yes":
      return await doConfirm(args.sb, args.chatId, cb.parts[0]!, "yes", args.messageId);
    case "conf_no":
      return await doConfirm(args.sb, args.chatId, cb.parts[0]!, "no", args.messageId);
    case "conf_edit":
      return await doCatMenu(args.sb, args.chatId, cb.parts[0]!, 0, args.messageId);
    case "access_grant":
      return await doAccessGrant(
        args.sb,
        args.member,
        args.chatId,
        Number(cb.parts[0]!),
        args.messageId,
      );
    case "access_deny":
      return await doAccessDeny(
        args.sb,
        args.member,
        args.chatId,
        Number(cb.parts[0]!),
        args.messageId,
      );
    case "mrev":
      return await doMemberAction(
        args.sb,
        args.member,
        args.chatId,
        "revoke",
        cb.parts[0]!,
        args.messageId,
      );
    case "mact":
      return await doMemberAction(
        args.sb,
        args.member,
        args.chatId,
        "activate",
        cb.parts[0]!,
        args.messageId,
      );
    case "mpromo":
      return await doMemberAction(
        args.sb,
        args.member,
        args.chatId,
        "promote",
        cb.parts[0]!,
        args.messageId,
      );
    case "mdemo":
      return await doMemberAction(
        args.sb,
        args.member,
        args.chatId,
        "demote",
        cb.parts[0]!,
        args.messageId,
      );
    case "subadd":
      return await doSubAdd(
        args.sb,
        args.member,
        args.chatId,
        cb.parts[0]!,
        args.messageId,
      );
    case "askapply":
      return await doAskApply(
        args.sb,
        args.member,
        args.chatId,
        cb.parts[0]!,
        args.messageId,
      );
    case "askcancel":
      return await doAskCancel(
        args.sb,
        args.member,
        args.chatId,
        cb.parts[0]!,
        args.messageId,
      );
    default:
      return { chatId: args.chatId, reply: { text: `Неизвестный callback: ${cb.kind}` } };
  }
}

interface ExpenseDetails {
  id: string;
  name: string;
  amount: number;
  currency: string;
  archived: boolean;
  category_name: string | null;
  family_member_id: string;
  created_at: string;
}

async function loadExpenseDetails(
  sb: SupabaseClient,
  expenseId: string,
): Promise<ExpenseDetails | null> {
  const res = await sb
    .from("expenses")
    .select("id, name, amount, currency, archived, family_member_id, created_at, category_id")
    .eq("id", expenseId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const row = res.data as {
    id: string;
    name: string;
    amount: number;
    currency: string;
    archived: boolean;
    family_member_id: string;
    created_at: string;
    category_id: string;
  };
  let categoryName: string | null = null;
  if (row.category_id) {
    const c = await sb.from("categories").select("name").eq("id", row.category_id).maybeSingle();
    categoryName = (c.data as { name: string } | null)?.name ?? null;
  }
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    currency: row.currency,
    archived: row.archived,
    category_name: categoryName,
    family_member_id: row.family_member_id,
    created_at: row.created_at,
  };
}

function expenseSummary(e: ExpenseDetails): string {
  const cat = e.category_name ?? "?";
  return `${e.amount.toFixed(2)} ${e.currency} ${e.name} → ${cat}`;
}

async function doConfirm(
  sb: SupabaseClient,
  chatId: number,
  expenseId: string,
  action: "yes" | "no",
  editMessageId?: number,
): Promise<CallbackOutput> {
  // The high-amount/uncertain keyboard carries only ONE expense_id, but a user
  // message can produce multiple sibling rows. Apply the action to every
  // non-archived sibling in the same telegram_message_id batch so the user's
  // single tap reflects what they expect ("Да = подтвердить весь Записал").
  const seed = await sb.from("expenses")
    .select("telegram_message_id, family_member_id")
    .eq("id", expenseId).maybeSingle();
  const sib = seed.data as { telegram_message_id: number; family_member_id: string } | null;

  const patch = action === "yes"
    ? { needs_confirmation: false }
    : { archived: true, needs_confirmation: false };

  // Collect the affected IDs BEFORE applying the update, so we can render the
  // post-action summary regardless of whether the row was just archived.
  let affected: Array<{ id: string }> = [];
  if (sib?.telegram_message_id) {
    const q = await sb.from("expenses")
      .select("id")
      .eq("telegram_message_id", sib.telegram_message_id)
      .eq("family_member_id", sib.family_member_id)
      .eq("archived", false);
    affected = (q.data ?? []) as Array<{ id: string }>;
  }
  if (affected.length === 0) affected = [{ id: expenseId }];

  if (sib?.telegram_message_id) {
    const upd = await sb.from("expenses").update(patch)
      .eq("telegram_message_id", sib.telegram_message_id)
      .eq("family_member_id", sib.family_member_id)
      .eq("archived", false);
    if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  } else {
    const upd = await sb.from("expenses").update(patch).eq("id", expenseId);
    if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  }

  // Build a multi-line summary so the user sees EVERY row the action covered.
  const details = await Promise.all(affected.map((a) => loadExpenseDetails(sb, a.id)));
  const valid = details.filter((d): d is NonNullable<typeof d> => d !== null);
  const icon = action === "yes" ? "✅" : "❌";
  const head = action === "yes" ? "Подтверждено" : "Отменено";
  let text: string;
  if (valid.length === 1) {
    text = `${icon} ${head}: ${expenseSummary(valid[0]!)}`;
  } else {
    const lines = valid.map((e) => `- ${expenseSummary(e)}`);
    text = `${icon} ${head} ${valid.length}:\n${lines.join("\n")}`;
  }
  return {
    chatId,
    reply: { text },
    edit_message_id: editMessageId,
    answer_text: head,
  };
}

async function doUndo(
  sb: SupabaseClient,
  member: FamilyMember,
  chatId: number,
  expenseId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  const r = await sb.from("expenses").select(
    "id, family_member_id, created_at, archived, category_id",
  ).eq("id", expenseId).maybeSingle();
  const row = r.data as ExpenseRow | null;
  if (!row) return { chatId, reply: { text: "Запись не найдена." } };
  if (row.family_member_id !== member.id && member.role !== "admin") {
    return { chatId, reply: { text: "Можно отменять только свои записи." } };
  }
  const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60_000;
  if (ageMin > UNDO_WINDOW_MIN) {
    return {
      chatId,
      reply: {
        text: `Окно отмены ${UNDO_WINDOW_MIN} минут истекло (прошло ${ageMin.toFixed(0)} мин).`,
      },
    };
  }
  if (row.archived) return { chatId, reply: { text: "Запись уже отменена." } };
  await sb.from("expenses").update({ archived: true }).eq("id", expenseId);
  const detail = await loadExpenseDetails(sb, expenseId);
  const summary = detail ? expenseSummary(detail) : "";
  return {
    chatId,
    reply: { text: `❌ Отменено: ${summary}` },
    edit_message_id: editMessageId,
    answer_text: "Отменено",
  };
}

const CAT_ID_PREFIX_LEN = 8;

async function doCatMenu(
  sb: SupabaseClient,
  chatId: number,
  expenseId: string,
  page: number,
  editMessageId?: number,
): Promise<CallbackOutput> {
  const offset = page * CAT_MENU_PAGE;
  // Pull one extra row to know if a "Ещё..." button is needed.
  const cats = await sb
    .from("categories")
    .select("id, name, is_fallback")
    .order("is_fallback", { ascending: true })
    .order("usage_count", { ascending: false })
    .order("name", { ascending: true })
    .range(offset, offset + CAT_MENU_PAGE);
  const list = (cats.data ?? []) as Array<{ id: string; name: string; is_fallback: boolean }>;
  const visible = list.slice(0, CAT_MENU_PAGE);
  const hasMore = list.length > CAT_MENU_PAGE;
  const buttons: Array<Array<{ text: string; callback_data: string }>> = visible.map((c) => [{
    text: c.is_fallback ? `${c.name} (fallback)` : c.name,
    callback_data: `catset:${expenseId}:${c.id.slice(0, CAT_ID_PREFIX_LEN)}`,
  }]);
  if (hasMore) {
    buttons.push([{
      text: "Ещё...",
      callback_data: `catall:${expenseId}:${page + 1}`,
    }]);
  } else if (page > 0) {
    buttons.push([{
      text: "В начало",
      callback_data: `catall:${expenseId}:0`,
    }]);
  }
  const detail = await loadExpenseDetails(sb, expenseId);
  const head = detail
    ? `Выбери категорию для:\n${detail.amount.toFixed(2)} ${detail.currency} ${detail.name}`
    : "Выбери категорию:";
  return {
    chatId,
    reply: {
      text: head,
      reply_markup: { inline_keyboard: buttons },
    },
    edit_message_id: editMessageId,
  };
}

async function doCatSet(
  sb: SupabaseClient,
  chatId: number,
  expenseId: string,
  catRef: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  // catRef may be a full UUID (legacy) or an 8-char prefix (new short form).
  // Resolve to the full id by scanning the small categories table.
  let categoryId: string | null = null;
  if (catRef.length === 36) {
    categoryId = catRef;
  } else {
    const all = await sb.from("categories").select("id");
    const match = ((all.data ?? []) as Array<{ id: string }>).find((c) => c.id.startsWith(catRef));
    categoryId = match?.id ?? null;
  }
  if (!categoryId) {
    return { chatId, reply: { text: "Категория не найдена. Попробуй ещё раз." } };
  }

  // Capture old category so we can retrain it too.
  const before = await sb.from("expenses").select("category_id").eq("id", expenseId).maybeSingle();
  const oldCat = (before.data as { category_id: string } | null)?.category_id ?? null;

  const upd = await sb.from("expenses").update({
    category_id: categoryId,
    corrected_by_user: true,
    needs_confirmation: false,
  }).eq("id", expenseId);
  if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };

  // Immediate centroid update so the next "молоко" already gets the new one.
  await Promise.all([
    retrainCategory(sb, categoryId),
    oldCat ? retrainCategory(sb, oldCat) : Promise.resolve(0),
  ]).catch((err) => log("warn", "catset_retrain_failed", { error: String(err) }));

  const detail = await loadExpenseDetails(sb, expenseId);
  const summary = detail ? expenseSummary(detail) : "";
  return {
    chatId,
    reply: { text: `✅ Записал: ${summary}` },
    edit_message_id: editMessageId,
    answer_text: "Категория обновлена",
  };
}

// --- Pending-access handlers (admin-only) ---------------------------------

async function doAccessGrant(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  targetTid: number,
  editMessageId?: number,
): Promise<CallbackOutput> {
  if (actor.role !== "admin") {
    return { chatId, reply: { text: "Только админ может выдавать доступ." } };
  }
  if (!Number.isFinite(targetTid) || targetTid <= 0) {
    return { chatId, reply: { text: "Неверный telegram_id." } };
  }

  const pendingRes = await sb.from("pending_access")
    .select("first_name, username, requested_at").eq("telegram_id", targetTid).maybeSingle();
  const pending = pendingRes.data as
    | { first_name: string | null; username: string | null; requested_at: string }
    | null;

  // Idempotency: if the user is already a family member just edit the bubble.
  const existingMem = await sb.from("family_members")
    .select("id, name, active").eq("telegram_id", targetTid).maybeSingle();
  if (existingMem.data) {
    const m = existingMem.data as { id: string; name: string; active: boolean };
    if (!m.active) {
      await sb.from("family_members").update({ active: true }).eq("id", m.id);
    }
    await sb.from("pending_access").delete().eq("telegram_id", targetTid);
    return {
      chatId,
      reply: {
        text: `✅ ${m.name} (${targetTid}) уже в семье, доступ восстановлен.`,
      },
      edit_message_id: editMessageId,
      answer_text: "Готово",
    };
  }

  const safeName = (pending?.first_name ?? "").replace(/[^\p{L}\p{N}\s_.-]/gu, "").slice(0, 80)
    .trim() || "Member";
  const ins = await sb.from("family_members").insert({
    name: safeName,
    telegram_id: targetTid,
    username: pending?.username ?? null,
    role: "member",
    active: true,
  }).select("id").maybeSingle();
  if (ins.error) {
    log("error", "access_grant_insert_failed", {
      target: targetTid,
      error: ins.error.message,
    });
    return { chatId, reply: { text: `Ошибка: ${ins.error.message}` } };
  }
  const newId = (ins.data as { id: string } | null)?.id ?? null;

  await sb.from("pending_access").delete().eq("telegram_id", targetTid);

  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "access_granted",
    targetId: newId,
    targetName: safeName,
    details: { telegram_id: targetTid, username: pending?.username ?? null },
  });

  // Greet the new member so they know access has been granted.
  await notifyUser(
    targetTid,
    `✅ Доступ к FinBot предоставлен. Привет, ${safeName}! Напиши /start чтобы начать.`,
  );

  return {
    chatId,
    reply: {
      text: `✅ Доступ выдан: <b>${safeName}</b> (${targetTid})`,
    },
    edit_message_id: editMessageId,
    answer_text: "Доступ выдан",
  };
}

async function doAccessDeny(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  targetTid: number,
  editMessageId?: number,
): Promise<CallbackOutput> {
  if (actor.role !== "admin") {
    return { chatId, reply: { text: "Только админ может отклонять запросы." } };
  }
  const pendingRes = await sb.from("pending_access")
    .select("first_name, username").eq("telegram_id", targetTid).maybeSingle();
  const pending = pendingRes.data as
    | { first_name: string | null; username: string | null }
    | null;
  const name = pending?.first_name ?? `id=${targetTid}`;

  await sb.from("pending_access").delete().eq("telegram_id", targetTid);

  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "access_denied",
    targetId: null,
    targetName: name,
    details: { telegram_id: targetTid, username: pending?.username ?? null },
  });

  return {
    chatId,
    reply: { text: `🚫 Запрос отклонён: <b>${name}</b> (${targetTid})` },
    edit_message_id: editMessageId,
    answer_text: "Отклонено",
  };
}

// --- Member-management actions (admin only, edit /members in place) -------

type MemberAction = "revoke" | "activate" | "promote" | "demote";

async function doMemberAction(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  action: MemberAction,
  memberId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  if (actor.role !== "admin") {
    return { chatId, reply: { text: "Только админ может менять состав." } };
  }
  if (!/^[0-9a-f-]{36}$/i.test(memberId)) {
    return { chatId, reply: { text: "Неверный member id." } };
  }

  const row = await sb.from("family_members")
    .select("id, name, telegram_id, role, active, username")
    .eq("id", memberId).maybeSingle();
  if (!row.data) return { chatId, reply: { text: "Участник не найден." } };
  const m = row.data as {
    id: string;
    name: string;
    telegram_id: number;
    role: string;
    active: boolean;
    username: string | null;
  };

  // Self-protection guards.
  if (m.telegram_id === actor.telegram_id && (action === "revoke" || action === "demote")) {
    return {
      chatId,
      reply: {
        text: action === "revoke"
          ? "Нельзя отозвать доступ у самого себя."
          : "Нельзя снять админа с самого себя (нужен хотя бы один админ).",
      },
      answer_text: "Запрещено",
    };
  }

  // Apply the change.
  let patch: Record<string, unknown> = {};
  let auditAction = "";
  let auditDetails: Record<string, unknown> = {
    telegram_id: m.telegram_id,
    username: m.username,
  };
  switch (action) {
    case "revoke":
      if (!m.active) {
        return {
          chatId,
          reply: { text: `${m.name} уже отключен.` },
          answer_text: "Уже отключен",
        };
      }
      patch = { active: false };
      auditAction = "member_revoked";
      break;
    case "activate":
      if (m.active) {
        return {
          chatId,
          reply: { text: `${m.name} уже активен.` },
          answer_text: "Уже активен",
        };
      }
      patch = { active: true };
      auditAction = "member_reactivated";
      auditDetails.role = m.role;
      break;
    case "promote":
      if (m.role === "admin") {
        return {
          chatId,
          reply: { text: `${m.name} уже админ.` },
          answer_text: "Уже админ",
        };
      }
      patch = { role: "admin" };
      auditAction = "member_promoted";
      auditDetails = { ...auditDetails, from_role: m.role, to_role: "admin" };
      break;
    case "demote":
      if (m.role === "member") {
        return {
          chatId,
          reply: { text: `${m.name} уже не админ.` },
          answer_text: "Уже member",
        };
      }
      patch = { role: "member" };
      auditAction = "member_demoted";
      auditDetails = { ...auditDetails, from_role: m.role, to_role: "member" };
      break;
  }

  const upd = await sb.from("family_members").update(patch).eq("id", memberId);
  if (upd.error) {
    log("error", "member_action_failed", {
      action,
      member: memberId,
      error: upd.error.message,
    });
    return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  }

  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: auditAction,
    targetId: m.id,
    targetName: m.name,
    details: auditDetails,
  });

  // Notify the affected user directly so they know what happened to them.
  const dm: Record<MemberAction, string> = {
    revoke: "🚫 Ваш доступ к FinBot отозван администратором.",
    activate: `✅ Доступ к FinBot восстановлен. ${m.name}, можешь снова пользоваться ботом.`,
    promote: "⭐ Тебе выдана роль администратора FinBot.",
    demote: "ℹ Роль администратора снята. Доступ к боту сохранён.",
  };
  await notifyUser(m.telegram_id, dm[action]);

  // Re-render the /members list IN PLACE so admin sees the updated state and
  // can chain actions without re-typing /members.
  const refreshed = await membersCommand(sb, actor);
  return {
    chatId,
    reply: refreshed,
    edit_message_id: editMessageId,
    answer_text: {
      revoke: "Доступ отозван",
      activate: "Восстановлен",
      promote: "Повышен",
      demote: "Понижен",
    }[action],
  };
}

// --- Subscription detector: add a detected pattern to recurring_expenses --

async function doSubAdd(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  expenseId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  if (actor.role !== "admin") {
    return { chatId, reply: { text: "Только админ." } };
  }
  if (!/^[0-9a-f-]{36}$/i.test(expenseId)) {
    return { chatId, reply: { text: "Неверный id." } };
  }

  const ex = await sb.from("expenses")
    .select("id, name, amount, currency, category_id, family_member_id")
    .eq("id", expenseId).maybeSingle();
  if (!ex.data) return { chatId, reply: { text: "Запись не найдена." } };
  const e = ex.data as {
    id: string;
    name: string;
    amount: number;
    currency: string;
    category_id: string;
    family_member_id: string;
  };

  // Find all matching expenses to pick the most-common day-of-month for the
  // recurring schedule.
  const matches = await sb.from("expenses")
    .select("expense_date")
    .eq("archived", false)
    .eq("family_member_id", e.family_member_id)
    .eq("currency", e.currency)
    .eq("amount", e.amount)
    .ilike("name", e.name);
  const dayCounts = new Map<number, number>();
  for (const r of ((matches.data ?? []) as Array<{ expense_date: string }>)) {
    const d = Number(r.expense_date.slice(8, 10));
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  let dayOfMonth = new Date().getUTCDate();
  let best = 0;
  for (const [d, c] of dayCounts.entries()) {
    if (c > best) {
      best = c;
      dayOfMonth = d;
    }
  }

  // Skip if already a recurring entry for the same (member, name, currency, amount).
  const dup = await sb.from("recurring_expenses")
    .select("id")
    .eq("family_member_id", e.family_member_id)
    .eq("currency", e.currency)
    .eq("amount", e.amount)
    .ilike("name", e.name)
    .maybeSingle();
  if (dup.data) {
    return {
      chatId,
      reply: { text: `Уже в регулярных: ${e.name} ${e.amount} ${e.currency}.` },
      edit_message_id: editMessageId,
      answer_text: "Уже добавлено",
    };
  }

  const ins = await sb.from("recurring_expenses").insert({
    name: e.name,
    amount: e.amount,
    currency: e.currency,
    category_id: e.category_id,
    family_member_id: e.family_member_id,
    day_of_month: dayOfMonth,
    active: true,
  }).select("id").maybeSingle();
  if (ins.error) {
    log("error", "subadd_insert_failed", { error: ins.error.message });
    return { chatId, reply: { text: `Ошибка: ${ins.error.message}` } };
  }

  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "recurring_added",
    targetId: (ins.data as { id: string } | null)?.id ?? null,
    targetName: e.name,
    details: {
      amount: e.amount,
      currency: e.currency,
      day_of_month: dayOfMonth,
      source_expense_id: e.id,
    },
  });

  return {
    chatId,
    reply: {
      text: `✅ Добавил в регулярные: ${e.name} ${e.amount} ${e.currency}, ${dayOfMonth}-го числа.`,
    },
    edit_message_id: editMessageId,
    answer_text: "Добавлено",
  };
}

// --- /ask agent proposal apply/cancel ------------------------------------

interface ProposalRow {
  id: string;
  proposer_family_member_id: string;
  proposer_telegram_id: number;
  question: string;
  actions: Array<Record<string, unknown>>;
  status: string;
  expires_at: string;
}

async function loadProposal(
  sb: SupabaseClient,
  proposalId: string,
): Promise<ProposalRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
  const r = await sb.from("ask_proposals")
    .select(
      "id, proposer_family_member_id, proposer_telegram_id, question, actions, status, expires_at",
    )
    .eq("id", proposalId).maybeSingle();
  return (r.data as ProposalRow | null) ?? null;
}

async function doAskApply(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  proposalId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  const p = await loadProposal(sb, proposalId);
  if (!p) {
    return {
      chatId,
      reply: { text: "Предложение не найдено или удалено." },
      edit_message_id: editMessageId,
    };
  }
  if (p.proposer_family_member_id !== actor.id && actor.role !== "admin") {
    return { chatId, reply: { text: "Подтвердить может только автор запроса (или админ)." } };
  }
  if (p.status !== "pending") {
    return {
      chatId,
      reply: { text: `Это предложение уже ${p.status}.` },
      edit_message_id: editMessageId,
    };
  }
  if (new Date(p.expires_at).getTime() < Date.now()) {
    await sb.from("ask_proposals").update({ status: "expired" }).eq("id", p.id);
    return {
      chatId,
      reply: { text: "Срок предложения истёк (10 мин). Спроси ещё раз." },
      edit_message_id: editMessageId,
    };
  }

  let applied = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const a of p.actions) {
    const kind = String(a.kind ?? "");
    try {
      if (kind === "delete_expense") {
        const id = String(a.expense_id);
        const upd = await sb.from("expenses").update({ archived: true }).eq("id", id);
        if (upd.error) throw new Error(upd.error.message);
        applied++;
      } else if (kind === "recategorize_expense") {
        const id = String(a.expense_id);
        const newCat = String(a.new_category_id);
        const upd = await sb.from("expenses")
          .update({ category_id: newCat, corrected_by_user: true, needs_confirmation: false })
          .eq("id", id);
        if (upd.error) throw new Error(upd.error.message);
        applied++;
      } else if (kind === "delete_receipt") {
        const id = String(a.receipt_id);
        const updLines = await sb.from("expenses").update({ archived: true })
          .eq("receipt_id", id).eq("archived", false);
        if (updLines.error) throw new Error(updLines.error.message);
        const updRec = await sb.from("receipts").update({ archived: true }).eq("id", id);
        if (updRec.error) throw new Error(updRec.error.message);
        applied++;
      } else if (kind === "mark_reconciled") {
        const id = String(a.expense_id);
        const pm = String(a.payment_method);
        const override = typeof a.amount_pln_override === "number" &&
            a.amount_pln_override > 0
          ? a.amount_pln_override
          : null;
        const patch: Record<string, unknown> = {
          reconciled_at: new Date().toISOString(),
          payment_method: pm,
        };
        if (override !== null) patch.amount_pln = override;
        const upd = await sb.from("expenses").update(patch).eq("id", id);
        if (upd.error) throw new Error(upd.error.message);
        applied++;
      } else {
        throw new Error(`unknown action: ${kind}`);
      }
    } catch (err) {
      failed++;
      failures.push(`${kind}: ${(err as Error).message}`);
      log("warn", "ask_apply_action_failed", {
        proposal: p.id,
        kind,
        error: (err as Error).message,
      });
    }
  }

  await sb.from("ask_proposals").update({
    status: "applied",
    applied_at: new Date().toISOString(),
    applied_count: applied,
    failed_count: failed,
  }).eq("id", p.id);

  await recordAudit(sb, {
    actorTelegramId: actor.telegram_id,
    actorFamilyMemberId: actor.id,
    action: "ask_proposal_applied",
    targetId: p.id,
    targetName: p.question.slice(0, 80),
    details: { actions: p.actions, applied, failed },
  });

  const head = failed === 0
    ? `✅ Применено ${applied} из ${p.actions.length}.`
    : `⚠ Применено ${applied}, не удалось ${failed} из ${p.actions.length}.`;
  const failList = failures.length > 0 ? `\n\n` + failures.slice(0, 5).join("\n") : "";

  return {
    chatId,
    reply: { text: head + failList },
    edit_message_id: editMessageId,
    answer_text: failed === 0 ? "Готово" : `Применено ${applied}/${p.actions.length}`,
  };
}

async function doAskCancel(
  sb: SupabaseClient,
  actor: FamilyMember,
  chatId: number,
  proposalId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
  const p = await loadProposal(sb, proposalId);
  if (!p) {
    return {
      chatId,
      reply: { text: "Предложение не найдено." },
      edit_message_id: editMessageId,
    };
  }
  if (p.proposer_family_member_id !== actor.id && actor.role !== "admin") {
    return { chatId, reply: { text: "Отменить может только автор (или админ)." } };
  }
  if (p.status === "pending") {
    await sb.from("ask_proposals").update({ status: "cancelled" }).eq("id", p.id);
    await recordAudit(sb, {
      actorTelegramId: actor.telegram_id,
      actorFamilyMemberId: actor.id,
      action: "ask_proposal_cancelled",
      targetId: p.id,
      targetName: p.question.slice(0, 80),
      details: { actions_count: p.actions.length },
    });
  }
  return {
    chatId,
    reply: { text: `❌ Предложение отменено (${p.actions.length} действий не применены).` },
    edit_message_id: editMessageId,
    answer_text: "Отменено",
  };
}
