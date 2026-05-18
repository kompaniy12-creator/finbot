// Routes a Telegram update to the appropriate command handler.
// Pure: takes (update, sb), returns a CommandReply describing what to send.
// Sending happens in the index.ts wrapper.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember, TelegramUpdate } from "../_shared/types.ts";
import {
  auditCommand,
  categoriesCommand,
  type CommandReply,
  dashboardCommand,
  healthCommand,
  helpCommand,
  historyCommand,
  startCommand,
  statsCommand,
  unauthorizedReply,
  undoCommand,
} from "./commands.ts";
import { formatReply, processTextMessage } from "./text_pipeline.ts";

export interface RouteContext {
  sb: SupabaseClient;
  member: FamilyMember;
}

/**
 * Parse the text of a Telegram message into (command, args).
 * Telegram commands are like "/help" or "/audit 4f...uuid" or "/start@BotName".
 */
export function parseCommand(
  text: string | undefined,
): { cmd: string; args: string } | null {
  if (!text || !text.startsWith("/")) return null;
  const space = text.indexOf(" ");
  const head = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space + 1).trim();
  const at = head.indexOf("@");
  const cmd = (at < 0 ? head : head.slice(0, at)).slice(1).toLowerCase();
  return { cmd, args: rest };
}

const ADMIN_COMMANDS = new Set(["health", "audit", "budget"]);

export async function routeCommand(
  ctx: RouteContext,
  cmd: string,
  args: string,
): Promise<CommandReply> {
  if (ADMIN_COMMANDS.has(cmd) && ctx.member.role !== "admin") {
    return { text: "Эта команда доступна только админу." };
  }
  switch (cmd) {
    case "start":
      return startCommand(ctx.member);
    case "help":
      return helpCommand(ctx.member);
    case "categories":
      return await categoriesCommand(ctx.sb);
    case "dashboard":
      return dashboardCommand();
    case "health":
      return await healthCommand(ctx.sb);
    case "audit":
      return await auditCommand(ctx.sb, args.trim());
    case "history":
      return await historyCommand(ctx.sb, ctx.member);
    case "stats":
      return await statsCommand(ctx.sb, ctx.member);
    case "undo":
      return await undoCommand(ctx.sb, ctx.member);
    case "recurring":
    case "budget":
      return {
        text: `Команда /${cmd} включается в позднем milestone. Сейчас бот в стадии сборки.`,
      };
    default:
      return { text: `Не знаю команду /${cmd}. Попробуй /help.` };
  }
}

export interface DispatchInput {
  update: TelegramUpdate;
  member: FamilyMember;
  sb: SupabaseClient;
}

export interface DispatchOutput {
  chatId: number;
  reply: CommandReply;
}

/**
 * Top-level dispatch: returns what to send for a single update.
 * Returns null if there is nothing to reply (e.g. callback handled elsewhere,
 * or update has no message).
 */
export async function dispatch(
  input: DispatchInput,
): Promise<DispatchOutput | null> {
  const msg = input.update.message ?? input.update.edited_message;
  if (!msg) return null;

  const cmd = parseCommand(msg.text);
  if (cmd) {
    const reply = await routeCommand(
      { sb: input.sb, member: input.member },
      cmd.cmd,
      cmd.args,
    );
    return { chatId: msg.chat.id, reply };
  }

  // Non-command text -> full pipeline (M7). Voice/photo land in M8/M9.
  if (msg.text) {
    const result = await processTextMessage({
      sb: input.sb,
      member: input.member,
      text: msg.text,
      telegramMessageId: msg.message_id,
    });
    if (!result) {
      return {
        chatId: msg.chat.id,
        reply: {
          text:
            "Не понял, что записать. Попробуй: «кофе 12 zł» или «бензин 200 zł и продукты 80 zł».",
        },
      };
    }
    return { chatId: msg.chat.id, reply: { text: formatReply(result) } };
  }

  return { chatId: msg.chat.id, reply: unauthorizedReply() };
}

export function refuseUnauthorized(
  update: TelegramUpdate,
): DispatchOutput | null {
  const msg = update.message ?? update.edited_message;
  if (!msg) return null;
  return { chatId: msg.chat.id, reply: unauthorizedReply() };
}
