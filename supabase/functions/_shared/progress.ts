// Lightweight Telegram progress helper. Pipelines accept an optional
// ProgressEmitter and call `update(text)` at each stage. The emitter
// owns the initial sendMessage and edits the SAME message id from then on,
// so the user sees a single replacing-text bubble instead of a chain.

export interface ProgressEmitter {
  /** Replace the bubble text. Swallows errors (best-effort UX). */
  update(text: string): Promise<void>;
  /** The Telegram message_id of the bubble (so callers can persist it). */
  messageId(): number;
}

async function tgFetch(
  method: string,
  body: Record<string, unknown>,
  botToken?: string,
): Promise<unknown> {
  const token = botToken ?? Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  const resp = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return await resp.json().catch(() => null);
}

/**
 * Send the initial bubble and return an emitter that edits it on each update.
 * Returns null if the initial sendMessage fails (calling code falls back to
 * sending one final reply at the end).
 */
export async function startProgress(
  chatId: number,
  initialText: string,
  botToken?: string,
): Promise<ProgressEmitter | null> {
  const sent = await tgFetch("sendMessage", {
    chat_id: chatId,
    text: initialText,
  }, botToken) as { ok?: boolean; result?: { message_id: number } } | null;
  if (!sent?.ok || !sent.result?.message_id) return null;
  const msgId = sent.result.message_id;
  return makeEmitterFor(chatId, msgId, botToken);
}

/**
 * Wrap an existing message id (e.g. the cron sweep recovers the ack message
 * created by tg-webhook earlier).
 */
export function makeEmitterFor(
  chatId: number,
  msgId: number,
  botToken?: string,
): ProgressEmitter {
  return {
    messageId: () => msgId,
    async update(text: string) {
      await tgFetch("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text,
      }, botToken);
    },
  };
}
