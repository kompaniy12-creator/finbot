// Routes a Telegram update to the appropriate command handler.
// Pure: takes (update, sb), returns a CommandReply describing what to send.
// Sending happens in the index.ts wrapper.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember, TelegramUpdate } from "../_shared/types.ts";
import {
  askCommand,
  auditCommand,
  categoriesCommand,
  type CommandReply,
  dashboardCommand,
  demoteCommand,
  grantCommand,
  healthCommand,
  helpCommand,
  historyCommand,
  meCommand,
  membersCommand,
  promoteCommand,
  revokeCommand,
  runAskAndBuildReply,
  startCommand,
  statsCommand,
  subscriptionsCommand,
  unauthorizedReply,
  undoCommand,
  webCommand,
  webLogoutCommand,
} from "./commands.ts";
import type { AskTurn } from "../_shared/ask_agent.ts";
import { classifyIntent } from "../_shared/intent.ts";
import { formatReply, highAmountKeyboard, processTextMessage } from "./text_pipeline.ts";
import { formatDebtReply, processDebtMessage } from "./debt_pipeline.ts";
import { processVoiceMessage } from "./voice_pipeline.ts";
import { type PhotoOutcome, processPhotoMessage } from "./photo_pipeline.ts";
import { type BankPipelineOutcome, processBankStatement } from "./bank_pipeline.ts";
import { startProgress } from "../_shared/progress.ts";

export interface RouteContext {
  sb: SupabaseClient;
  member: FamilyMember;
  chatId?: number;
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

const ADMIN_COMMANDS = new Set([
  "health",
  "audit",
  "budget",
  "members",
  "grant",
  "revoke",
  "promote",
  "demote",
  "subscriptions",
]);

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
      if (args.trim().startsWith("backup-confirm")) {
        const upd = await ctx.sb.from("system_health")
          .update({ backup_key_confirmed: true })
          .eq("id", 1);
        if (upd.error) return { text: `DB error: ${upd.error.message}` };
        return { text: "Подтверждено. Backups активны." };
      }
      return await healthCommand(ctx.sb);
    case "audit":
      return await auditCommand(ctx.sb, args.trim());
    case "history":
      return await historyCommand(ctx.sb, ctx.member);
    case "stats":
      return await statsCommand(ctx.sb, ctx.member);
    case "me":
      return await meCommand(ctx.sb, ctx.member);
    case "ask":
      return await askCommand(ctx.sb, args, ctx.member, ctx.chatId);
    case "undo":
      return await undoCommand(ctx.sb, ctx.member);
    case "members":
      return await membersCommand(ctx.sb, ctx.member);
    case "grant":
      return await grantCommand(ctx.sb, args, ctx.member);
    case "revoke":
      return await revokeCommand(ctx.sb, args, ctx.member);
    case "promote":
      return await promoteCommand(ctx.sb, args, ctx.member);
    case "demote":
      return await demoteCommand(ctx.sb, args, ctx.member);
    case "subscriptions":
      return await subscriptionsCommand(ctx.sb, ctx.member);
    case "web":
      return await webCommand(ctx.sb, ctx.member);
    case "web_logout":
      return await webLogoutCommand(ctx.sb, ctx.member);
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

  // M11: edited message semantics (SPEC §6.5). Hard-delete the previous
  // expense rows for this (telegram_message_id, family_member_id), letting the
  // audit trigger write 'archive' first, then re-process below as usual.
  if (input.update.edited_message) {
    const prev = await input.sb
      .from("expenses")
      .select("id")
      .eq("telegram_message_id", msg.message_id)
      .eq("family_member_id", input.member.id);
    const ids = ((prev.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length > 0) {
      // UPDATE archived=true so audit trigger captures the archive event.
      await input.sb.from("expenses").update({ archived: true }).in("id", ids);
      // Then hard-delete so the unique (msg_id, fm_id, line_index) constraint
      // frees up for the re-insert.
      await input.sb.from("expenses").delete().in("id", ids);
    }
  }

  const cmd = parseCommand(msg.text);
  if (cmd) {
    const reply = await routeCommand(
      { sb: input.sb, member: input.member, chatId: msg.chat.id },
      cmd.cmd,
      cmd.args,
    );
    return { chatId: msg.chat.id, reply };
  }

  // Conversational /ask: if this is a Telegram reply to a bot message that
  // belongs to an ask_threads row, route to the agent with prior context
  // instead of the expense parser. Without this, the follow-up "Как считал?"
  // hits processTextMessage and gets stored as a 0.01 PLN transaction.
  if (msg.text && msg.reply_to_message) {
    const parentId = msg.reply_to_message.message_id;
    const parentFromBot = msg.reply_to_message.from?.is_bot === true;
    if (parentFromBot && typeof parentId === "number") {
      const thread = await input.sb
        .from("ask_threads")
        .select("history")
        .eq("chat_id", msg.chat.id)
        .eq("bot_message_id", parentId)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (thread.data) {
        const rawHistory = (thread.data as { history: unknown }).history;
        const priorTurns: AskTurn[] = Array.isArray(rawHistory)
          ? (rawHistory as unknown[]).flatMap((r) => {
            if (!r || typeof r !== "object") return [];
            const o = r as Record<string, unknown>;
            if (typeof o.question === "string" && typeof o.answer === "string") {
              return [{ question: o.question, answer: o.answer }];
            }
            return [];
          })
          : [];
        const reply = await runAskAndBuildReply({
          sb: input.sb,
          viewer: input.member,
          chatId: msg.chat.id,
          question: msg.text.slice(0, 500),
          priorTurns,
        });
        return { chatId: msg.chat.id, reply };
      }
    }
  }

  // Non-command text. Classify intent: a question or chitchat goes straight
  // to the analyst (no /ask needed), so the user can talk to the bot like a
  // live financial advisor. An expense-shaped message goes to the parser.
  // If the parser comes back empty, we fall back to the analyst rather than
  // dead-end with "Не понял что записать".
  if (msg.text) {
    const intent = classifyIntent(msg.text);

    if (intent === "question") {
      const reply = await runAskAndBuildReply({
        sb: input.sb,
        viewer: input.member,
        chatId: msg.chat.id,
        question: msg.text.slice(0, 500),
      });
      return { chatId: msg.chat.id, reply };
    }

    if (intent === "debt") {
      const outcome = await processDebtMessage({
        sb: input.sb,
        member: input.member,
        text: msg.text,
      });
      return { chatId: msg.chat.id, reply: { text: formatDebtReply(outcome) } };
    }

    const result = await processTextMessage({
      sb: input.sb,
      member: input.member,
      text: msg.text,
      telegramMessageId: msg.message_id,
    });
    if (!result || result.expenses.length === 0) {
      // Parser saw something expense-shaped but couldn't extract a row.
      // Hand off to the analyst so the user gets a useful conversational
      // reply instead of the old dead-end "Не понял что записать".
      const reply = await runAskAndBuildReply({
        sb: input.sb,
        viewer: input.member,
        chatId: msg.chat.id,
        question: msg.text.slice(0, 500),
      });
      return { chatId: msg.chat.id, reply };
    }
    const kb = highAmountKeyboard(result);
    return {
      chatId: msg.chat.id,
      reply: kb
        ? {
          text: formatReply(result),
          reply_markup: kb as unknown as CommandReply["reply_markup"],
        }
        : { text: formatReply(result) },
    };
  }

  // Voice (M8): transcribe via Groq Whisper -> text pipeline.
  if (msg.voice) {
    const prog = await startProgress(msg.chat.id, "🎙 Принимаю голосовое...");
    const outcome = await processVoiceMessage({
      sb: input.sb,
      member: input.member,
      msg,
      progress: prog ?? undefined,
    });
    const text = formatVoiceReply(outcome);
    if (prog) {
      await prog.update(text);
      return null; // already edited the bubble, no extra reply needed
    }
    return { chatId: msg.chat.id, reply: { text } };
  }

  // Photo receipt (M9 + M10 media groups).
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;

    // Media group (M10): buffer photo and ack only on first arrival; cron sweep
    // processes the group ~30s later and edits the ack bubble with progress.
    if (msg.media_group_id) {
      // Check if this is the first photo of the group (atomic via sequential
      // insert + count). If so, send ack and store its msg_id on the row.
      const existing = await input.sb
        .from("media_group_buffer")
        .select("ack_message_id")
        .eq("media_group_id", msg.media_group_id)
        .not("ack_message_id", "is", null)
        .limit(1)
        .maybeSingle();
      const existingAckId = (existing.data as { ack_message_id: number } | null)?.ack_message_id ??
        null;

      let ackMsgId: number | null = existingAckId;
      if (!ackMsgId) {
        const prog = await startProgress(msg.chat.id, "📸 Принимаю альбом, секунду...");
        ackMsgId = prog?.messageId() ?? null;
      }

      await input.sb.from("media_group_buffer").insert({
        media_group_id: msg.media_group_id,
        telegram_message_id: msg.message_id,
        family_member_id: input.member.id,
        file_id: largest.file_id,
        ack_message_id: ackMsgId,
        chat_id: msg.chat.id,
      });
      return null; // ack already sent (if at all); cron-sweep will edit it
    }

    // Caption-triggered bank-app screenshot path. If the user explicitly
    // tells us this is a bank screenshot, we parse it like a PDF statement
    // (extract lines, reconcile) instead of treating it as a store receipt.
    if (msg.caption && isBankScreenshotCaption(msg.caption)) {
      const prog = await startProgress(msg.chat.id, "📱 Распознаю выписку из приложения банка...");
      const ins = await input.sb.from("bank_statements").insert({
        family_member_id: input.member.id,
        source: "other",
        filename: `screenshot_${msg.message_id}.jpg`,
        status: "parsing",
        raw_text: `TG_FILE_ID:${largest.file_id}`,
      }).select("id").maybeSingle();
      const stmtId = (ins.data as { id: string } | null)?.id;
      if (!stmtId) {
        return {
          chatId: msg.chat.id,
          reply: { text: `Не смог зарегистрировать скриншот выписки.` },
        };
      }
      let summaryText: string;
      try {
        const outcome = await processBankStatement({
          sb: input.sb,
          member: input.member,
          statementId: stmtId,
          mediaType: "image",
          mimeType: "image/jpeg",
        });
        summaryText = formatBankReply(outcome, "скриншот выписки");
      } catch (err) {
        summaryText = `Ошибка распознавания выписки: ${(err as Error).message}`;
      }
      if (prog) {
        await prog.update(summaryText);
        return null;
      }
      return { chatId: msg.chat.id, reply: { text: summaryText } };
    }

    const prog = await startProgress(msg.chat.id, "📸 Принимаю фото...");
    let text: string;
    try {
      const outcome = await processPhotoMessage({
        sb: input.sb,
        member: input.member,
        fileId: largest.file_id,
        telegramMessageId: msg.message_id,
        caption: msg.caption,
        progress: prog ?? undefined,
      });
      text = formatPhotoReply(outcome);
    } catch (err) {
      text = "❌ Не смог обработать чек: " + ((err as Error).message ?? "internal_error") +
        "\nПопробуй прислать фото ещё раз.";
    }
    if (prog) {
      await prog.update(text);
      return null;
    }
    return { chatId: msg.chat.id, reply: { text } };
  }

  // Document (HEIC sometimes lands here): handle if it's an image MIME.
  if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    const outcome = await processPhotoMessage({
      sb: input.sb,
      member: input.member,
      fileId: msg.document.file_id,
      fileMime: msg.document.mime_type,
      telegramMessageId: msg.message_id,
      caption: msg.caption,
    });
    return { chatId: msg.chat.id, reply: { text: formatPhotoReply(outcome) } };
  }

  // PDF document → bank statement pipeline (parse + auto-reconcile).
  if (msg.document && msg.document.mime_type === "application/pdf") {
    const filename = msg.document.file_name || "statement.pdf";
    const ins = await input.sb.from("bank_statements").insert({
      family_member_id: input.member.id,
      source: "other",
      filename,
      status: "parsing",
      raw_text: `TG_FILE_ID:${msg.document.file_id}`,
    }).select("id").maybeSingle();
    const stmtId = (ins.data as { id: string } | null)?.id;
    if (!stmtId) {
      return {
        chatId: msg.chat.id,
        reply: { text: `Не смог зарегистрировать выписку. Попробуй прислать ещё раз.` },
      };
    }
    const prog = await startProgress(msg.chat.id, "📄 Анализирую выписку...");
    let summaryText: string;
    try {
      const outcome = await processBankStatement({
        sb: input.sb,
        member: input.member,
        statementId: stmtId,
      });
      summaryText = formatBankReply(outcome, filename);
    } catch (err) {
      summaryText = `Ошибка обработки выписки: ${(err as Error).message}`;
    }
    if (prog) {
      await prog.update(summaryText);
      return null;
    }
    return { chatId: msg.chat.id, reply: { text: summaryText } };
  }

  return { chatId: msg.chat.id, reply: unauthorizedReply() };
}

// Detect "this photo is a bank-app screenshot, not a store receipt" via the
// caption. Conservative: requires an explicit keyword so we don't redirect
// every random Vodafone-receipt photo into the bank pipeline.
function isBankScreenshotCaption(caption: string): boolean {
  const c = caption.toLowerCase();
  return (
    c.includes("выписк") ||
    c.includes("выпис") ||
    c.includes("банк") ||
    c.includes("mbank") ||
    c.includes("santander") ||
    c.includes("revolut") ||
    c.includes("statement") ||
    c.includes("historia") ||
    c.includes("history")
  );
}

function formatBankReply(outcome: BankPipelineOutcome, filename: string): string {
  switch (outcome.kind) {
    case "no_file":
      return `Не смог найти файл выписки. Пришли PDF ещё раз.`;
    case "download_failed":
      return `Не смог скачать PDF из Telegram. Пришли ещё раз.`;
    case "parse_failed":
      if (outcome.error === "truncated") {
        return `Выписка слишком длинная, я не смог разобрать её за один раз. ` +
          `Пришли её за более короткий период (например, по неделям или по дням).`;
      }
      if (outcome.error === "zod_parse_failed" || outcome.error === "no_tool_use_block") {
        return `Не смог распознать структуру выписки. ` +
          `Проверь, что это PDF из банка (mBank/Revolut), и пришли ещё раз. ` +
          `Если не помогает, пришли за более короткий период.`;
      }
      return `Не смог разобрать выписку: ${outcome.error.slice(0, 100)}. ` +
        `Попробуй прислать ещё раз или другим форматом.`;
    case "ok": {
      const s = outcome.summary;
      const head = `📄 «${filename}» - разобрал ${outcome.total_lines} ${
        outcome.total_lines === 1 ? "операцию" : "операций"
      } (${outcome.source}).\n\n`;
      // Plain text (no HTML/Markdown) because progress.update() edits the
      // ack message without a parse_mode header - any <b> or _italic_
      // would otherwise show as literal characters.
      const stats = [
        `✓ Сверено с чеками: ${s.matched}`,
        s.auto_created > 0 ? `➕ Создал новых: ${s.auto_created}` : null,
        s.no_candidate > 0 ? `❓ Не нашёл в базе: ${s.no_candidate}` : null,
        s.ambiguous > 0 ? `⚠ Несколько кандидатов: ${s.ambiguous}` : null,
        s.skipped > 0 ? `↺ Пропущено (переводы/комиссии): ${s.skipped}` : null,
      ].filter(Boolean).join("\n");
      const tail = s.no_candidate > 0
        ? `\n\nНесверённые позиции остались для триажа - открой Mini App и проверь.`
        : s.auto_created > 0
        ? `\n\nНовые позиции автоматически разнесены по категориям - проверь в Mini App, поправь если что-то ушло не туда.`
        : `\n\nВсе позиции сверены ✓`;
      return head + stats + tail;
    }
  }
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
    case "duplicate": {
      const who = outcome.existing_merchant ?? "без названия";
      const reason = outcome.reason === "image_hash"
        ? "Это то же фото, что я уже обрабатывал."
        : "Уже есть чек с такими же магазином, датой и суммой.";
      return `⚠ Похоже на дубликат. ${reason}\n\nСуществующий чек: ${who}, ${
        outcome.existing_total.toFixed(2)
      } ${outcome.existing_currency}, ${outcome.existing_date}.\n\nЕсли это другая покупка, удали старый чек в Mini App и пришли фото заново.`;
    }
    case "ok": {
      const isIncome = outcome.tx_kind === "income";
      const emoji = isIncome ? "💰" : "✅";
      const sign = isIncome ? "+" : "";
      const merchantStr = outcome.merchant ? `${outcome.merchant} ` : "";
      const header = `${emoji} ${merchantStr}(${sign}${
        outcome.total.toFixed(2)
      } ${outcome.currency}, проверено ${outcome.expense_count}/${outcome.expected_count} поз.)`;
      const bullet = isIncome ? "➕" : "-";
      const lines = outcome.items.map((it) =>
        `${bullet} ${it.name} → ${it.category_name}: ${sign}${it.amount.toFixed(2)} ${it.currency}`
      );
      const warn = outcome.reconciled
        ? ""
        : "\n\n⚠ Сумма позиций не совпала с итогом (±5%), пометил для ревью.";
      const hint = "\n\n_Категорию можно поправить в Mini App, если что-то ушло не туда._";
      return `${header}\n\n${lines.join("\n")}${warn}${hint}`;
    }
    case "partial": {
      const isIncome = outcome.tx_kind === "income";
      const sign = isIncome ? "+" : "";
      const merchantStr = outcome.merchant ? `${outcome.merchant} ` : "";
      const header =
        `⚠ ${merchantStr}сохранил ${outcome.expense_count} из ${outcome.expected_count} поз. (итог ${sign}${
          outcome.total.toFixed(2)
        } ${outcome.currency})`;
      return `${header}\n\nЧасть позиций не сохранилась. Удали чек в Mini App и пришли фото заново, либо проверь руками что записалось.`;
    }
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
