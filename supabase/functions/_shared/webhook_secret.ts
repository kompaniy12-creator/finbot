// Telegram webhook secret check.
//
// Modern: Telegram's native secret_token feature sends the secret in the
// X-Telegram-Bot-Api-Secret-Token request header (never in the URL). The
// secret is a separate value from the bot token, so even if our webhook
// URL leaks the bot token is not exposed.
//
// Legacy: older versions of this bot used a ?secret=<token> URL parameter
// with the bot token itself as the secret. We keep accepting the legacy
// form ONLY during transition; once the webhook is re-registered with the
// new secret_token, drop the legacy fallback.

const HEADER = "x-telegram-bot-api-secret-token";

export function checkSecret(
  req: Request,
  webhookSecret: string,
  legacyBotToken?: string,
): boolean {
  if (!webhookSecret && !legacyBotToken) return false;

  // Preferred path: header.
  if (webhookSecret) {
    const header = req.headers.get(HEADER) || "";
    if (header && header === webhookSecret) return true;
  }

  // Legacy fallback: URL param. Will be removed after transition.
  if (legacyBotToken) {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    if (secret && secret === legacyBotToken) return true;
  }

  return false;
}
