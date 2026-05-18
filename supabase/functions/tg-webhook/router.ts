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
import { processVoiceMessage } from "./voice_pipeline.ts";
import { type PhotoOutcome, processPhotoMessage } from "./photo_pipeline.ts";

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

  // Non-command text -> full pipeline (M7).
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

  // Voice (M8): transcribe via Groq Whisper -> text pipeline.
  if (msg.voice) {
    const outcome = await processVoiceMessage({
      sb: input.sb,
      member: input.member,
      msg,
    });
    return { chatId: msg.chat.id, reply: { text: formatVoiceReply(outcome) } };
  }

  // Photo receipt (M9 + M10 media groups).
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;

    // Media group (M10): buffer photo and ack only on first arrival; cron sweep
    // processes the group ~30s later.
    if (msg.media_group_id) {
      await input.sb.from("media_group_buffer").insert({
        media_group_id: msg.media_group_id,
        telegram_message_id: msg.message_id,
        family_member_id: input.member.id,
        file_id: largest.file_id,
      });
      const first = await input.sb
        .from("media_group_buffer")
        .select("telegram_message_id")
        .eq("media_group_id", msg.media_group_id)
        .order("telegram_message_id", { ascending: true })
        .limit(1)
        .maybeSingle();
      const firstId = (first.data as { telegram_message_id: number } | null)?.telegram_message_id;
      if (firstId !== undefined && firstId === msg.message_id) {
        return { chatId: msg.chat.id, reply: { text: "Принимаю альбом, секунду..." } };
      }
      return null;
    }

    const outcome = await processPhotoMessage({
      sb: input.sb,
      member: input.member,
      fileId: largest.file_id,
      telegramMessageId: msg.message_id,
    });
    return { chatId: msg.chat.id, reply: { text: formatPhotoReply(outcome) } };
  }

  // Document (HEIC sometimes lands here): handle if it's an image MIME.
  if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    const outcome = await processPhotoMessage({
      sb: input.sb,
      member: input.member,
      fileId: msg.document.file_id,
      fileMime: msg.document.mime_type,
      telegramMessageId: msg.message_id,
    });
    return { chatId: msg.chat.id, reply: { text: formatPhotoReply(outcome) } };
  }

  return { chatId: msg.chat.id, reply: unauthorizedReply() };
}

function formatPhotoReply(outcome: PhotoOutcome): string {
  switch (outcome.kind) {
    case "heic_unsupported":
      return "HEIC пока не поддерживаю (M9 v1: только JPEG/PNG). Открой фото на iPhone, нажми «Поделиться -> Сохранить в Файлы» и пришли как файл с расширением .jpg, либо настрой iOS «Камера → Форматы → Совместимый».";
    case "unsupported_mime":
      return `Не поддерживаемый формат: ${outcome.mime}. Пришли JPEG или PNG.`;
    case "download_failed":
      return "Не смог скачать фото из Telegram.";
    case "vision_failed":
      return `Vision не сработал: ${outcome.error}`;
    case "parse_failed":
      return "Не смог распознать чек. Сфотографируй ровнее и при хорошем свете.";
    case "ok":
      return outcome.reconciled
        ? `Записал чек, ${outcome.expense_count} позиций.`
        : `Записал чек, ${outcome.expense_count} позиций. Внимание: сумма позиций не совпала с итогом (±5%), пометил для ревью.`;
  }
}

function formatVoiceReply(
  outcome: Awaited<ReturnType<typeof processVoiceMessage>>,
): string {
  switch (outcome.kind) {
    case "too_long":
      return `Голосовое слишком длинное (${outcome.duration}s, лимит ${outcome.maxAllowed}s).`;
    case "download_failed":
      return `Не смог скачать голосовое: ${outcome.error}`;
    case "transcribe_failed":
      return `Не смог распознать: ${outcome.error}`;
    case "language_rejected":
      return `Распознал язык "${outcome.detected}" - не в whitelist (ru/uk/pl/en).`;
    case "no_text":
      return "Не понял, что записать. Скажи как «кофе 12 zł».";
    case "ok": {
      const head = `Распознал: ${outcome.transcript.slice(0, 100)}\n\n`;
      return head + formatReply(outcome.result);
    }
  }
}

export function refuseUnauthorized(
  update: TelegramUpdate,
): DispatchOutput | null {
  const msg = update.message ?? update.edited_message;
  if (!msg) return null;
  return { chatId: msg.chat.id, reply: unauthorizedReply() };
}
