// Inline-keyboard callback handlers for tg-webhook.
// Callback data uses a colon-separated tag format:
//   undo:<expense_id>
//   catmenu:<expense_id>           - show top 5 categories
//   catall:<expense_id>:<page>     - paginate over all categories
//   catset:<expense_id>:<cat_id>   - change category + mark corrected_by_user

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import type { CommandReply } from "./commands.ts";

const UNDO_WINDOW_MIN = Number(Deno.env.get("UNDO_WINDOW_MINUTES") ?? "10");
const CAT_MENU_PAGE = 5;

export interface CallbackOutput {
  chatId: number;
  reply: CommandReply;
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
}): Promise<CallbackOutput> {
  const cb = parseCallback(args.data);
  if (!cb) {
    return { chatId: args.chatId, reply: { text: "Неизвестный callback." } };
  }

  switch (cb.kind) {
    case "undo":
      return await doUndo(args.sb, args.member, args.chatId, cb.parts[0]!);
    case "catmenu":
      return await doCatMenu(args.sb, args.member, args.chatId, cb.parts[0]!, 0);
    case "catall": {
      const page = Number(cb.parts[1] ?? "0");
      return await doCatMenu(args.sb, args.member, args.chatId, cb.parts[0]!, page);
    }
    case "catset":
      return await doCatSet(args.sb, args.member, args.chatId, cb.parts[0]!, cb.parts[1]!);
    case "conf_yes":
      return await doConfirm(args.sb, args.chatId, cb.parts[0]!, "yes");
    case "conf_no":
      return await doConfirm(args.sb, args.chatId, cb.parts[0]!, "no");
    case "conf_edit":
      return await doCatMenu(args.sb, args.member, args.chatId, cb.parts[0]!, 0);
    default:
      return { chatId: args.chatId, reply: { text: `Неизвестный callback: ${cb.kind}` } };
  }
}

async function doConfirm(
  sb: SupabaseClient,
  chatId: number,
  expenseId: string,
  action: "yes" | "no",
): Promise<CallbackOutput> {
  const patch = action === "yes"
    ? { needs_confirmation: false }
    : { archived: true, needs_confirmation: false };
  const upd = await sb.from("expenses").update(patch).eq("id", expenseId);
  if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  return {
    chatId,
    reply: { text: action === "yes" ? "Подтверждено." : "Отменено." },
  };
}

async function doUndo(
  sb: SupabaseClient,
  member: FamilyMember,
  chatId: number,
  expenseId: string,
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
  return { chatId, reply: { text: "Отменено." } };
}

async function doCatMenu(
  sb: SupabaseClient,
  _member: FamilyMember,
  chatId: number,
  expenseId: string,
  page: number,
): Promise<CallbackOutput> {
  const offset = page * CAT_MENU_PAGE;
  const cats = await sb
    .from("categories")
    .select("id, name")
    .order("usage_count", { ascending: false })
    .range(offset, offset + CAT_MENU_PAGE - 1);
  const list = (cats.data ?? []) as Array<{ id: string; name: string }>;
  const buttons = list.map((c) => [{
    text: c.name,
    callback_data: `catset:${expenseId}:${c.id}`,
  }]);
  // Pagination: add next-page button (best-effort, no total-pages tracking here).
  buttons.push([{
    text: "Ещё...",
    callback_data: `catall:${expenseId}:${page + 1}`,
  }]);
  return {
    chatId,
    reply: {
      text: "Выбери категорию:",
      // deno-lint-ignore no-explicit-any
      reply_markup: { inline_keyboard: buttons as any },
    },
  };
}

async function doCatSet(
  sb: SupabaseClient,
  _member: FamilyMember,
  chatId: number,
  expenseId: string,
  categoryId: string,
): Promise<CallbackOutput> {
  const upd = await sb.from("expenses").update({
    category_id: categoryId,
    corrected_by_user: true,
  }).eq("id", expenseId);
  if (upd.error) return { chatId, reply: { text: `Ошибка: ${upd.error.message}` } };
  return { chatId, reply: { text: "Категория обновлена." } };
}
