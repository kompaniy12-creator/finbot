import { Bot, webhookCallback } from "grammy";
import { z } from "zod";
import { log } from "../_shared/log.ts";
import { checkSecret } from "../_shared/webhook_secret.ts";

interface BotBundle {
  token: string;
  handler: (req: Request) => Promise<Response>;
}

let bundle: BotBundle | null = null;

function getBundle(): BotBundle {
  if (bundle) return bundle;
  const token = z.string().min(40).parse(Deno.env.get("TELEGRAM_BOT_TOKEN"));
  const bot = new Bot(token);

  bot.command("start", (ctx) => {
    return ctx.reply(
      "FinBot v1. Авторизация ещё не настроена, ждём M4. Пиши админу, если это ты.",
    );
  });

  bot.command("help", (ctx) => {
    return ctx.reply(
      "Команды появятся в M4. Сейчас бот в режиме skeleton (M1).",
    );
  });

  bundle = {
    token,
    handler: webhookCallback(bot, "std/http"),
  };
  return bundle;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("ok", { status: 200 });
  }

  let b: BotBundle;
  try {
    b = getBundle();
  } catch (err) {
    log("error", "webhook_env_missing", { error: (err as Error).message });
    return new Response("server misconfigured", { status: 500 });
  }

  if (!checkSecret(req, b.token)) {
    log("warn", "webhook_unauthorized", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return new Response("unauthorized", { status: 401 });
  }

  try {
    return await b.handler(req);
  } catch (err) {
    log("error", "webhook_error", { error: (err as Error).message });
    return new Response("internal error", { status: 500 });
  }
});
