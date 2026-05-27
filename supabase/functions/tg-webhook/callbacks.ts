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
//
// Byte-budget sanity check:
//   "catset:" (7) + uuid (36) + ":" (1) + 8 = 52 bytes <= 64. OK.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import type { CommandReply } from "./commands.ts";
import { retrainCategory } from "../_shared/retrain.ts";
import { log } from "../_shared/log.ts";
import { recordAudit } from "../_shared/audit.ts";

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

  // Best-effort: greet the new member directly so they know they can start.
  try {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (token) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetTid,
          text: `Привет, ${safeName}! Тебе выдан доступ к FinBot. Напиши /start чтобы начать.`,
        }),
      });
    }
  } catch (_e) { /* ignore */ }

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
