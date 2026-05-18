// tg-webhook entry point (Edge Function).
// Flow per SPEC §3 + §6:
//   1. GET -> 200 ok (uptime check).
//   2. POST without ?secret=<bot_token> -> 401.
//   3. Parse Telegram update via Zod.
//   4. authorize(from.id) -> if null, notify admin + reply rejection.
//   5. dedupe(message_id, family_member_id) for non-command messages.
//   6. dispatch() -> routeCommand or pipeline placeholder.
//   7. sendMessage via Telegram Bot API.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { authorize } from "../_shared/auth.ts";
import { dedupe, markDone, markError } from "../_shared/idempotency.ts";
import { checkSecret } from "../_shared/webhook_secret.ts";
import { TelegramUpdateSchema } from "../_shared/types.ts";
import { type CommandReply, type ReplyKeyboardButton } from "./commands.ts";
import { dispatch, parseCommand, refuseUnauthorized } from "./router.ts";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  TELEGRAM_ADMIN_TELEGRAM_ID: z.string().regex(/^\d+$/),
});

let envCached: z.infer<typeof envSchema> | null = null;

function getEnv() {
  if (envCached) return envCached;
  envCached = envSchema.parse({
    TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_ADMIN_TELEGRAM_ID: Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID"),
  });
  return envCached;
}

async function tgRequest(
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN } = getEnv();
  const resp = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    log("error", "tg_request_failed", { method, status: resp.status, body: text });
  }
}

async function sendReply(chatId: number, reply: CommandReply): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: reply.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (reply.reply_markup) {
    body.reply_markup = reply.reply_markup;
  }
  await tgRequest("sendMessage", body);
}

async function notifyAdminText(text: string): Promise<void> {
  const { TELEGRAM_ADMIN_TELEGRAM_ID } = getEnv();
  await tgRequest("sendMessage", {
    chat_id: Number(TELEGRAM_ADMIN_TELEGRAM_ID),
    text,
    parse_mode: "HTML",
  });
}

// Exported for testing.
export { type ReplyKeyboardButton, sendReply };

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("ok", { status: 200 });
  }

  let env: z.infer<typeof envSchema>;
  try {
    env = getEnv();
  } catch (err) {
    log("error", "webhook_env_missing", { error: (err as Error).message });
    return new Response("server misconfigured", { status: 500 });
  }

  if (!checkSecret(req, env.TELEGRAM_BOT_TOKEN)) {
    log("warn", "webhook_unauthorized", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return new Response("unauthorized", { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    log("warn", "webhook_bad_json", { error: (err as Error).message });
    return new Response("bad json", { status: 400 });
  }

  const parse = TelegramUpdateSchema.safeParse(raw);
  if (!parse.success) {
    log("warn", "webhook_bad_schema", { issues: parse.error.issues.slice(0, 3) });
    return new Response("ok", { status: 200 }); // 200 so Telegram does not retry
  }
  const update = parse.data;
  const msg = update.message ?? update.edited_message;
  const fromId = msg?.from?.id ?? update.callback_query?.from.id;

  if (!fromId) {
    log("info", "webhook_no_from_id", { update_id: update.update_id });
    return new Response("ok", { status: 200 });
  }

  const sb = adminClient();

  const member = await authorize(fromId, sb);
  if (!member) {
    log("warn", "webhook_unauthorized_telegram_user", { telegram_id: fromId });
    const out = refuseUnauthorized(update);
    if (out) await sendReply(out.chatId, out.reply);
    await notifyAdminText(
      `Unauthorized access attempt: telegram_id=${fromId}, name="${
        msg?.from?.first_name ?? "?"
      }", username=@${msg?.from?.username ?? "?"}`,
    );
    return new Response("ok", { status: 200 });
  }

  // Idempotent skip for non-command messages (commands are idempotent by design).
  const cmd = parseCommand(msg?.text);
  if (msg && !cmd) {
    const fresh = await dedupe(msg.message_id, member.id, sb);
    if (!fresh) {
      log("info", "webhook_dedupe_skip", {
        telegram_message_id: msg.message_id,
        member: member.id,
      });
      return new Response("ok", { status: 200 });
    }
  }

  try {
    const out = await dispatch({ update, member, sb });
    if (out) await sendReply(out.chatId, out.reply);
    if (msg && !cmd) await markDone(msg.message_id, member.id, sb);
  } catch (err) {
    log("error", "webhook_dispatch_failed", { error: (err as Error).message });
    if (msg && !cmd) {
      await markError(msg.message_id, member.id, sb, (err as Error).message);
    }
    return new Response("error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
