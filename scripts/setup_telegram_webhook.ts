// scripts/setup_telegram_webhook.ts
//
// Register the Telegram webhook so updates flow to our Edge Function.
// Run: deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts
//
// Requires TELEGRAM_BOT_TOKEN and SUPABASE_PROJECT_REF in env.

import { z } from "npm:zod@3.23.8";

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  SUPABASE_PROJECT_REF: z.string().min(10),
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  SUPABASE_PROJECT_REF: Deno.env.get("SUPABASE_PROJECT_REF"),
});

const webhookUrl =
  `https://${env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook?secret=${env.TELEGRAM_BOT_TOKEN}`;

console.log(
  "Setting webhook to https://" + env.SUPABASE_PROJECT_REF +
    ".supabase.co/functions/v1/tg-webhook?secret=<bot_token>",
);

const setRes = await fetch(
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
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
