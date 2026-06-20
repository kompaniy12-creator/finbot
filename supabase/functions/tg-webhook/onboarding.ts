// SaaS onboarding wizard. A new tenant is walked through a short conversation
// instead of typing commands: pick language -> tell name -> paste Anthropic key
// -> (optional) paste Groq key. Progress is tracked in tenants.onboarding_step;
// when it clears, the user is fully set up. Each step's reply is localized via
// _shared/i18n.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { isLocale, type Locale, LOCALES, t } from "../_shared/i18n.ts";

export interface OnbReply {
  text: string;
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

function langKeyboard(): OnbReply["reply_markup"] {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < LOCALES.length; i += 2) {
    rows.push(
      LOCALES.slice(i, i + 2).map((l) => ({
        text: `${l.flag} ${l.native}`,
        callback_data: `ob:lang:${l.code}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

function skipKeyboard(locale: Locale): OnbReply["reply_markup"] {
  return { inline_keyboard: [[{ text: t(locale, "skip_btn"), callback_data: "ob:skip" }]] };
}

// First wizard message, shown right after a code is redeemed. No locale yet, so
// the prompt is bilingual and the buttons carry each language's native name.
export function onboardingGreeting(): OnbReply {
  return { text: t("ru", "choose_lang"), reply_markup: langKeyboard() };
}

function sanitizeName(raw: string): string {
  return raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function tenantName(sb: SupabaseClient, tenantId: string): Promise<string> {
  const r = await sb.from("tenants").select("name").eq("id", tenantId).maybeSingle();
  return (r.data as { name: string } | null)?.name ?? "";
}

async function finish(sb: SupabaseClient, tenantId: string): Promise<void> {
  await sb.from("tenants").update({ onboarding_step: null }).eq("id", tenantId);
}

// Process one wizard turn and return the localized reply to send. Performs the
// DB writes (locale, name, keys, step advance) itself.
export async function advanceOnboarding(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  step: string;
  locale: Locale;
  text?: string;
  callbackData?: string;
}): Promise<OnbReply> {
  const { sb, member, step } = args;
  let locale = args.locale;
  const cb = args.callbackData ?? "";
  const text = (args.text ?? "").trim();

  if (step === "lang") {
    if (cb.startsWith("ob:lang:")) {
      const code = cb.slice("ob:lang:".length);
      locale = isLocale(code) ? code : "ru";
      await sb.from("tenants").update({ locale, onboarding_step: "name" })
        .eq("id", member.tenant_id);
      return { text: t(locale, "ask_name") };
    }
    return { text: t("ru", "choose_lang"), reply_markup: langKeyboard() };
  }

  if (step === "name") {
    const name = sanitizeName(text);
    if (!name) return { text: t(locale, "ask_name") };
    await sb.from("tenants").update({ name, onboarding_step: "apikey" })
      .eq("id", member.tenant_id);
    await tenantDb(sb, member.tenant_id).from("family_members").update({ name })
      .eq("id", member.id);
    return { text: t(locale, "ask_apikey", { name }) };
  }

  if (step === "apikey") {
    if (!/^sk-ant-\S{20,}$/.test(text)) return { text: t(locale, "bad_apikey") };
    await sb.from("tenants").update({ anthropic_api_key: text, onboarding_step: "groqkey" })
      .eq("id", member.tenant_id);
    return { text: t(locale, "ask_groqkey"), reply_markup: skipKeyboard(locale) };
  }

  if (step === "groqkey") {
    const name = await tenantName(sb, member.tenant_id);
    if (cb === "ob:skip") {
      await finish(sb, member.tenant_id);
      return { text: t(locale, "done_nogroq", { name }) };
    }
    if (/^gsk_[A-Za-z0-9]{20,}$/.test(text)) {
      await sb.from("tenants").update({ groq_api_key: text }).eq("id", member.tenant_id);
      await finish(sb, member.tenant_id);
      return { text: t(locale, "done", { name }) };
    }
    return { text: t(locale, "bad_groqkey"), reply_markup: skipKeyboard(locale) };
  }

  // Unknown step - clear it so the user is not stuck.
  await finish(sb, member.tenant_id);
  return { text: t(locale, "done", { name: member.name }) };
}
