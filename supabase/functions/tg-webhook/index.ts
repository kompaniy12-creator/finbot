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
import { NO_API_KEY } from "../_shared/claude.ts";
import { seedCategoriesForTenant } from "../_shared/seed_categories.ts";
import { dedupe, markDone, markError } from "../_shared/idempotency.ts";
import { checkSecret } from "../_shared/webhook_secret.ts";
import { isTelegramIp } from "../_shared/telegram_ip.ts";
import { checkAndBump, type RateLimitKind } from "../_shared/rate_limit.ts";
import { TelegramUpdateSchema } from "../_shared/types.ts";
import { type CommandReply, type ReplyKeyboardButton } from "./commands.ts";
import { dispatch, parseCommand, refuseUnauthorized } from "./router.ts";
import { handleCallback } from "./callbacks.ts";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  TELEGRAM_ADMIN_TELEGRAM_ID: z.string().regex(/^\d+$/),
  // Optional during transition: if unset, we fall back to legacy URL-param
  // check (which uses the bot token). Once webhook is re-registered with the
  // secret_token, this becomes the only accepted path.
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
});

let envCached: z.infer<typeof envSchema> | null = null;

function getEnv() {
  if (envCached) return envCached;
  envCached = envSchema.parse({
    TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_ADMIN_TELEGRAM_ID: Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID"),
    TELEGRAM_WEBHOOK_SECRET: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
  });
  return envCached;
}

// Resolve which bot this request belongs to from the webhook secret header.
// Returns that bot's id (for tenant/member scoping), reply token, and mode.
// Matching is by X-Telegram-Bot-Api-Secret-Token; the family bot uses the
// legacy ?secret= path (no header), so when nothing matches we fall back to the
// family-mode bot row. Cached per cold start.
interface BotRow {
  id: string;
  mode: "family" | "saas";
  webhook_secret_name: string;
  token_secret_name: string;
}
let botsCache: BotRow[] | null = null;

async function loadBots(sb: ReturnType<typeof adminClient>): Promise<BotRow[]> {
  if (!botsCache) {
    const r = await sb.from("bots")
      .select("id, mode, webhook_secret_name, token_secret_name")
      .eq("active", true);
    botsCache = (r.data ?? []) as BotRow[];
  }
  return botsCache;
}

async function resolveBot(
  sb: ReturnType<typeof adminClient>,
  req: Request,
): Promise<
  { botId: string | null; token: string; mode: "family" | "saas"; matched: boolean }
> {
  const fallbackToken = getEnv().TELEGRAM_BOT_TOKEN;
  const bots = await loadBots(sb);
  const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const matched = header
    ? bots.find((b) => Deno.env.get(b.webhook_secret_name) === header)
    : undefined;
  // No header match -> the family bot (legacy ?secret= path).
  const bot = matched ?? bots.find((b) => b.mode === "family");
  if (!bot) return { botId: null, token: fallbackToken, mode: "family", matched: false };
  return {
    botId: bot.id,
    token: Deno.env.get(bot.token_secret_name) ?? fallbackToken,
    mode: bot.mode,
    matched: !!matched,
  };
}

async function tgRequest(
  method: string,
  body: Record<string, unknown>,
  botToken?: string,
): Promise<unknown> {
  const token = botToken ?? getEnv().TELEGRAM_BOT_TOKEN;
  const resp = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await resp.text();
  // Telegram returns HTTP 200 with {ok:false, description:"..."} for many
  // application-level errors (callback_data too long, message_not_modified,
  // entity parse, etc). Treat those as failures too so silent edits surface.
  if (!resp.ok) {
    log("error", "tg_request_http_failed", { method, status: resp.status, body: text });
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; description?: string; result?: unknown };
    if (parsed.ok === false) {
      log("error", "tg_request_api_failed", { method, description: parsed.description });
      return null;
    }
    return parsed.result ?? null;
  } catch (_e) {
    /* non-JSON 200 - ignore */
    return null;
  }
}

async function sendReply(
  chatId: number,
  reply: CommandReply,
  botToken?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: reply.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (reply.reply_markup) {
    body.reply_markup = reply.reply_markup;
  }
  const result = await tgRequest("sendMessage", body, botToken);
  if (reply.onSent) {
    const msgId = (result as { message_id?: number } | null)?.message_id;
    if (typeof msgId === "number") {
      try {
        await reply.onSent(msgId);
      } catch (err) {
        log("error", "onSent_callback_failed", { error: (err as Error).message });
      }
    }
  }
}

async function editReply(
  chatId: number,
  messageId: number,
  reply: CommandReply,
  botToken?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: reply.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (reply.reply_markup) {
    body.reply_markup = reply.reply_markup;
  } else {
    // Strip the buttons explicitly so the bubble no longer shows them.
    body.reply_markup = { inline_keyboard: [] };
  }
  await tgRequest("editMessageText", body, botToken);
}

async function notifyAdminWithButtons(
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
  botToken?: string,
): Promise<void> {
  const { TELEGRAM_ADMIN_TELEGRAM_ID } = getEnv();
  await tgRequest("sendMessage", {
    chat_id: Number(TELEGRAM_ADMIN_TELEGRAM_ID),
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  }, botToken);
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

  // P5: detect non-Telegram IPs and log them (defense-in-depth on top of the
  // webhook secret). Currently log-only so a mis-read XFF header doesn't
  // silently break delivery; once we've watched prod traffic for a day we
  // flip to a hard reject.
  const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") || "";
  if (clientIp && !isTelegramIp(clientIp)) {
    log("warn", "webhook_non_telegram_ip", { ip: clientIp });
  }

  // Identify the bot this request belongs to (by webhook secret header). Needed
  // both to authorize the request and to reply with the right token.
  const sb = adminClient();
  const bot = await resolveBot(sb, req);
  const botToken = bot.token;

  // P1: webhook secret. Valid if the secret_token header matches an active bot
  // (the SaaS bot's path), OR the legacy ?secret=<family_bot_token> URL param.
  if (
    !bot.matched && !checkSecret(req, env.TELEGRAM_WEBHOOK_SECRET ?? "", env.TELEGRAM_BOT_TOKEN)
  ) {
    log("warn", "webhook_unauthorized", { ip: clientIp || "unknown" });
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

  // P2: cheap webhook-wide rate limit BEFORE we authorize - even unauthorized
  // hits go in the bucket so a spam attack from a known telegram_id can't
  // hammer authorize().
  const webhookGate = await checkAndBump(sb, fromId, "webhook");
  if (!webhookGate.allowed) {
    log("warn", "rate_limit_hit", {
      telegram_id: fromId,
      kind: "webhook",
      count: webhookGate.count,
      limit: webhookGate.limit,
    });
    return new Response("rate_limited", { status: 429 });
  }

  const member = await authorize(bot.botId, fromId, sb);
  if (!member) {
    // SaaS bot: self-serve onboarding via invite code. An unknown user must
    // send "/start <code>"; a valid code creates their own tenant + seeds
    // categories. No code -> instructions. The family bot keeps the
    // pending-access / admin-approval flow below.
    if (bot.mode === "saas") {
      const chatId = msg?.chat?.id ?? update.callback_query?.from.id ?? fromId;
      const parsedCmd = parseCommand(msg?.text);
      const code = parsedCmd?.cmd === "start" ? parsedCmd.args.trim() : "";
      if (!code) {
        await sendReply(chatId, {
          text: "Привет! Это FinBot. Чтобы начать, пришли код приглашения так:\n" +
            "<code>/start ТВОЙ_КОД</code>",
        }, botToken);
        return new Response("ok", { status: 200 });
      }
      const firstName = msg?.from?.first_name ?? "Tester";
      const rpc = await sb.rpc("redeem_invite", {
        p_code: code,
        p_telegram_id: fromId,
        p_bot_id: bot.botId,
        p_first_name: firstName,
      });
      const res = (rpc.data ?? {}) as { tenant_id?: string; created?: boolean; error?: string };
      if (rpc.error || res.error || !res.tenant_id) {
        await sendReply(chatId, {
          text: "Код недействителен или уже использован. Проверь и пришли заново:\n" +
            "<code>/start ТВОЙ_КОД</code>",
        }, botToken);
        return new Response("ok", { status: 200 });
      }
      if (res.created) {
        await seedCategoriesForTenant(sb, res.tenant_id);
        log("info", "saas_onboarded", { telegram_id: fromId, tenant_id: res.tenant_id });
      }
      await sendReply(chatId, {
        text: "✅ Готово, твой FinBot настроен!\n\n" +
          "🔑 Последний шаг: подключи свой ключ Anthropic, чтобы я мог распознавать траты " +
          "(каждый платит за свой расход на ИИ). Получи ключ на " +
          "https://console.anthropic.com/settings/keys и пришли:\n" +
          "<code>/apikey sk-ant-...</code>\n\n" +
          "Для голосовых нужен бесплатный ключ Groq (https://console.groq.com/keys):\n" +
          "<code>/groqkey gsk_...</code>\n\n" +
          "После этого просто пиши траты текстом («кофе 12 zł»), шли фото чеков или голосовые - " +
          "я всё запишу и разложу по категориям. Открой «Дашборд» в меню бота, чтобы " +
          "видеть статистику, доходы, долги и кредиты.",
      }, botToken);
      return new Response("ok", { status: 200 });
    }

    log("warn", "webhook_unauthorized_telegram_user", { telegram_id: fromId });
    const out = refuseUnauthorized(update);
    if (out) await sendReply(out.chatId, out.reply, botToken);
    const firstName = msg?.from?.first_name ?? "?";
    const userName = msg?.from?.username ?? null;

    // Upsert pending request; only re-notify admin if quiet for > 1 hour
    // (avoid spamming the admin if the rejected user keeps trying).
    const existing = await sb.from("pending_access")
      .select("last_notified_at").eq("telegram_id", fromId).maybeSingle();
    const last = (existing.data as { last_notified_at: string } | null)?.last_notified_at;
    const lastMs = last ? new Date(last).getTime() : 0;
    const QUIET_MS = 60 * 60 * 1000;
    const shouldNotify = !existing.data || Date.now() - lastMs > QUIET_MS;

    await sb.from("pending_access").upsert({
      telegram_id: fromId,
      first_name: firstName,
      username: userName,
      ...(shouldNotify ? { last_notified_at: new Date().toISOString() } : {}),
    }, { onConflict: "telegram_id" });

    if (shouldNotify) {
      const tag = userName ? ` @${userName}` : "";
      const text = [
        `🔔 Запрос доступа: <b>${firstName}</b>${tag}`,
        `Telegram ID: <code>${fromId}</code>`,
      ].join("\n");
      await notifyAdminWithButtons(text, [[
        { text: "✅ Дать доступ", callback_data: `access_grant:${fromId}` },
        { text: "🚫 Отклонить", callback_data: `access_deny:${fromId}` },
      ]], botToken);
    }
    return new Response("ok", { status: 200 });
  }

  // Idempotent skip for non-command messages (commands are idempotent by design).
  const cmd = parseCommand(msg?.text);
  if (msg && !cmd) {
    const fresh = await dedupe(msg.message_id, member.id, member.tenant_id, sb);
    if (!fresh) {
      log("info", "webhook_dedupe_skip", {
        telegram_message_id: msg.message_id,
        member: member.id,
      });
      return new Response("ok", { status: 200 });
    }
  }

  // P2: per-kind rate limit. Photo/voice are the expensive ones (Claude Vision
  // and Whisper). Apply BEFORE handing off to the pipeline.
  const kindForLimit: RateLimitKind | null = update.callback_query
    ? "callback"
    : msg?.photo
    ? "photo"
    : msg?.voice
    ? "voice"
    : msg?.text
    ? "text"
    : null;
  if (kindForLimit) {
    const r = await checkAndBump(sb, fromId, kindForLimit);
    if (!r.allowed) {
      log("warn", "rate_limit_hit", {
        telegram_id: fromId,
        kind: kindForLimit,
        count: r.count,
        limit: r.limit,
      });
      if (msg?.chat?.id) {
        await sendReply(msg.chat.id, {
          text: `Достигнут дневной лимит на ${kindForLimit} (${r.limit}/день). ` +
            `Попробуй завтра или попроси админа поднять порог.`,
        }, botToken);
      }
      return new Response("ok", { status: 200 });
    }
  }

  try {
    // Callback queries (inline button presses) take a different path.
    if (update.callback_query) {
      const cq = update.callback_query;
      const out = await handleCallback({
        sb,
        member,
        botToken,
        data: cq.data ?? "",
        chatId: cq.message?.chat.id ?? cq.from.id,
        messageId: cq.message?.message_id,
      });
      if (out.edit_message_id) {
        await editReply(out.chatId, out.edit_message_id, out.reply, botToken);
      } else {
        await sendReply(out.chatId, out.reply, botToken);
      }
      // Acknowledge the callback so the spinning button stops.
      await tgRequest("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: out.answer_text ?? "",
      }, botToken);
      return new Response("ok", { status: 200 });
    }

    const out = await dispatch({ update, member, sb, botToken });
    if (out) await sendReply(out.chatId, out.reply, botToken);
    if (msg && !cmd) await markDone(msg.message_id, member.id, member.tenant_id, sb);
  } catch (err) {
    const errMsg = (err as Error).message;
    // SaaS tenant has not set their own API key yet: tell them how, ack 200 so
    // Telegram does not retry (the key, not a transient fault, is missing).
    if (errMsg === NO_API_KEY) {
      log("info", "webhook_no_api_key", { tenant_id: member.tenant_id });
      if (msg && !cmd) await markError(msg.message_id, member.id, member.tenant_id, sb, errMsg);
      if (msg?.chat?.id) {
        await sendReply(msg.chat.id, {
          text: "🔑 Чтобы я мог распознавать траты, нужен твой ключ Anthropic.\n\n" +
            "Получи его на https://console.anthropic.com/settings/keys и пришли командой:\n" +
            "<code>/apikey sk-ant-...</code>\n\n" +
            "Для голосовых нужен ещё ключ Groq (бесплатный, https://console.groq.com/keys):\n" +
            "<code>/groqkey gsk_...</code>",
        }, botToken);
      }
      return new Response("ok", { status: 200 });
    }
    log("error", "webhook_dispatch_failed", { error: errMsg });
    if (msg && !cmd) {
      await markError(msg.message_id, member.id, member.tenant_id, sb, errMsg);
    }
    return new Response("error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
