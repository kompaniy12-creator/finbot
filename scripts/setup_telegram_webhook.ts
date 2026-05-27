// scripts/setup_telegram_webhook.ts
//
// Register the Telegram webhook so updates flow to our Edge Function.
// Run: deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts
//
// Uses Telegram's native secret_token feature: the secret is sent via the
// X-Telegram-Bot-Api-Secret-Token request header, NOT in the URL. The bot
// token therefore never appears in webhook URLs / CDN logs / proxy logs.
//
// Requires TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_PROJECT_REF.

import { z } from "npm:zod@3.23.8";

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
  SUPABASE_PROJECT_REF: z.string().min(10),
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_WEBHOOK_SECRET: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
  SUPABASE_PROJECT_REF: Deno.env.get("SUPABASE_PROJECT_REF"),
});

// Clean URL - no secret query param. Telegram will send the secret in the
// X-Telegram-Bot-Api-Secret-Token header instead.
const webhookUrl =
  `https://${env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook`;

console.log(`Setting webhook -> ${webhookUrl} (secret via header)`);

const setRes = await fetch(
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: true,
      max_connections: 40,
    }),
  },
);

const setJson = await setRes.json();
console.log("setWebhook:", JSON.stringify(setJson, null, 2));

const infoRes = await fetch(
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`,
);
const infoJson = await infoRes.json();
console.log("getWebhookInfo:", JSON.stringify(infoJson, null, 2));

if (!setJson.ok) {
  console.error("FAIL: setWebhook returned !ok");
  Deno.exit(1);
}
