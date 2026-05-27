// Direct-message helper. Sends a Telegram message to an arbitrary user
// (typically a family member being granted/revoked/promoted). Best-effort:
// errors are logged but never thrown - the admin's action must succeed
// regardless of whether the target's DM arrives.

import { log } from "./log.ts";

export async function notifyUser(telegramId: number, text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      log("warn", "notify_user_http_failed", { tid: telegramId, status: resp.status });
    }
  } catch (err) {
    log("warn", "notify_user_failed", { tid: telegramId, error: (err as Error).message });
  }
}
