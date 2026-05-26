// Inline-keyboard callback handlers for tg-webhook.
// Callback data uses a colon-separated tag format:
//   undo:<expense_id>
//   catmenu:<expense_id>           - show top 5 categories
//   catall:<expense_id>:<page>     - paginate over all categories
//   catset:<expense_id>:<cat_id>   - change category + mark corrected_by_user

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import type { CommandReply } from "./commands.ts";
import { retrainCategory } from "../_shared/retrain.ts";
import { log } from "../_shared/log.ts";

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
  const patch = action === "yes"
    ? { needs_confirmation: false }
    : { archived: true, needs_confirmation: false };
  // Cancel may need to archive every sibling row from the same telegram_message_id
  // (the "3*400" high-amount flow inserts N rows but the button carries only one
  // expense_id; without this the other N-1 stayed visible).
  if (action === "no") {
    const tgId = await sb.from("expenses")
      .select("telegram_message_id, family_member_id")
      .eq("id", expenseId).maybeSingle();
    const sib = tgId.data as { telegram_message_id: number; family_member_id: string } | null;
    if (sib?.telegram_message_id) {
      await sb.from("expenses").update(patch)
        .eq("telegram_message_id", sib.telegram_message_id)
        .eq("family_member_id", sib.family_member_id)
        .eq("archived", false);
    } else {
      await sb.from("expenses").update(patch).eq("id", expenseId);
    }
  } else {
    const upd = await sb.from("expenses").update(patch).eq("id", expenseId);
    if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  }

  const detail = await loadExpenseDetails(sb, expenseId);
  const summary = detail ? expenseSummary(detail) : "";
  const text = action === "yes" ? `✅ Подтверждено: ${summary}` : `❌ Отменено: ${summary}`;
  return {
    chatId,
    reply: { text },
    edit_message_id: editMessageId,
    answer_text: action === "yes" ? "Подтверждено" : "Отменено",
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
    callback_data: `catset:${expenseId}:${c.id}`,
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
  categoryId: string,
  editMessageId?: number,
): Promise<CallbackOutput> {
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
