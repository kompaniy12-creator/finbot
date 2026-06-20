import { assertEquals, assertStringIncludes } from "@std/assert";
import { advanceOnboarding, onboardingGreeting } from "../supabase/functions/tg-webhook/onboarding.ts";
import type { FamilyMember } from "../supabase/functions/_shared/types.ts";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

const member = {
  id: "m1",
  tenant_id: TENANT,
  bot_id: "b1",
  telegram_id: 123,
  name: "Tester",
  role: "admin",
  active: true,
} as unknown as FamilyMember;

// Minimal Supabase mock: records tenant updates and serves the tenant row.
function makeSb(tenant: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      let op = "";
      let payload: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        update(p: Record<string, unknown>) {
          op = "update";
          payload = p;
          return chain;
        },
        select() {
          op = "select";
          return chain;
        },
        eq() {
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: table === "tenants" ? tenant : null, error: null });
        },
        then(resolve: (v: unknown) => void) {
          if (op === "update") {
            updates.push({ table, payload });
            if (table === "tenants") Object.assign(tenant, payload);
          }
          resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  return { sb, updates, tenant };
}

Deno.test("onboarding: greeting offers all four languages", () => {
  const g = onboardingGreeting();
  const codes = g.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data);
  assertEquals(codes.sort(), ["ob:lang:en", "ob:lang:pl", "ob:lang:ru", "ob:lang:uk"]);
});

Deno.test("onboarding: lang selection saves locale and advances to name", async () => {
  const { sb, tenant } = makeSb({ name: "Tester" });
  const reply = await advanceOnboarding({
    sb,
    member,
    step: "lang",
    locale: "ru",
    callbackData: "ob:lang:uk",
  });
  assertEquals(tenant.locale, "uk");
  assertEquals(tenant.onboarding_step, "name");
  // Reply is the Ukrainian name prompt.
  assertStringIncludes(reply.text, "звертатися");
});

Deno.test("onboarding: name step stores name and asks for the key", async () => {
  const { sb, tenant } = makeSb({ name: "Tester" });
  const reply = await advanceOnboarding({ sb, member, step: "name", locale: "en", text: "Serhii" });
  assertEquals(tenant.name, "Serhii");
  assertEquals(tenant.onboarding_step, "apikey");
  assertStringIncludes(reply.text, "Serhii");
  assertStringIncludes(reply.text, "sk-ant-");
});

Deno.test("onboarding: apikey step rejects a non-key without advancing", async () => {
  const { sb, tenant } = makeSb({ name: "Serhii", onboarding_step: "apikey" });
  const reply = await advanceOnboarding({ sb, member, step: "apikey", locale: "en", text: "hello" });
  assertEquals(tenant.onboarding_step, "apikey");
  assertStringIncludes(reply.text, "sk-ant-");
});

Deno.test("onboarding: apikey step accepts a key and advances to groqkey", async () => {
  const { sb, tenant } = makeSb({ name: "Serhii", onboarding_step: "apikey" });
  const key = "sk-ant-api03-" + "x".repeat(30);
  await advanceOnboarding({ sb, member, step: "apikey", locale: "ru", text: key });
  assertEquals(tenant.anthropic_api_key, key);
  assertEquals(tenant.onboarding_step, "groqkey");
});

Deno.test("onboarding: groqkey skip finishes onboarding", async () => {
  const { sb, tenant } = makeSb({ name: "Serhii", onboarding_step: "groqkey" });
  const reply = await advanceOnboarding({
    sb,
    member,
    step: "groqkey",
    locale: "ru",
    callbackData: "ob:skip",
  });
  assertEquals(tenant.onboarding_step, null);
  assertStringIncludes(reply.text, "Serhii");
});

Deno.test("onboarding: groqkey accepts a key and finishes", async () => {
  const { sb, tenant } = makeSb({ name: "Serhii", onboarding_step: "groqkey" });
  const key = "gsk_" + "a".repeat(40);
  await advanceOnboarding({ sb, member, step: "groqkey", locale: "ru", text: key });
  assertEquals(tenant.groq_api_key, key);
  assertEquals(tenant.onboarding_step, null);
});
