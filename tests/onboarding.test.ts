// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeMockSb } from "./helpers/mock_sb.ts";

// The wizard encrypts API keys (envelope) before storing; give crypto_box a KEK.
const KEK = btoa("envelope-master-kek-32bytes-ok!!");

import {
  advanceOnboarding,
  onboardingGreeting,
} from "../supabase/functions/tg-webhook/onboarding.ts";
import { decryptSecret } from "../supabase/functions/_shared/crypto_box.ts";
import type { FamilyMember } from "../supabase/functions/_shared/types.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";

const member = {
  id: "m1",
  tenant_id: TENANT,
  bot_id: "b1",
  telegram_id: 123,
  name: "Tester",
  role: "admin",
  active: true,
} as unknown as FamilyMember;

function setup(extra: Record<string, unknown> = {}) {
  const sb = makeMockSb({
    kekBase64: KEK,
    seed: { tenants: [{ id: TENANT, name: "Tester", ...extra }] },
  });
  const tenant = () => (sb._store.tenants ?? [])[0]!;
  return { sb: sb as any, tenant };
}

Deno.test("onboarding: greeting offers all four languages", () => {
  const g = onboardingGreeting();
  const codes = g.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data);
  assertEquals(codes.sort(), ["ob:lang:en", "ob:lang:pl", "ob:lang:ru", "ob:lang:uk"]);
});

Deno.test("onboarding: lang selection saves locale and advances to name", async () => {
  const { sb, tenant } = setup();
  const reply = await advanceOnboarding({
    sb,
    member,
    step: "lang",
    locale: "ru",
    callbackData: "ob:lang:uk",
  });
  assertEquals(tenant().locale, "uk");
  assertEquals(tenant().onboarding_step, "name");
  assertStringIncludes(reply.text, "звертатися");
});

Deno.test("onboarding: name step stores name and asks for the key", async () => {
  const { sb, tenant } = setup();
  const reply = await advanceOnboarding({ sb, member, step: "name", locale: "en", text: "Serhii" });
  assertEquals(tenant().name, "Serhii");
  assertEquals(tenant().onboarding_step, "apikey");
  assertStringIncludes(reply.text, "Serhii");
  assertStringIncludes(reply.text, "sk-ant-");
});

Deno.test("onboarding: apikey step rejects a non-key without advancing", async () => {
  const { sb, tenant } = setup({ onboarding_step: "apikey" });
  const reply = await advanceOnboarding({
    sb,
    member,
    step: "apikey",
    locale: "en",
    text: "hello",
  });
  assertEquals(tenant().onboarding_step, "apikey");
  assertStringIncludes(reply.text, "sk-ant-");
});

Deno.test("onboarding: apikey step encrypts the key (v2) and advances", async () => {
  const { sb, tenant } = setup({ onboarding_step: "apikey" });
  const key = "sk-ant-api03-" + "x".repeat(30);
  await advanceOnboarding({ sb, member, step: "apikey", locale: "ru", text: key });
  const stored = tenant().anthropic_api_key as string;
  assertEquals(stored.startsWith("v2:"), true);
  assertEquals(await decryptSecret(sb, TENANT, stored), key);
  assertEquals(tenant().onboarding_step, "groqkey");
});

Deno.test("onboarding: groqkey skip finishes onboarding", async () => {
  const { sb, tenant } = setup({ name: "Serhii", onboarding_step: "groqkey" });
  const reply = await advanceOnboarding({
    sb,
    member,
    step: "groqkey",
    locale: "ru",
    callbackData: "ob:skip",
  });
  assertEquals(tenant().onboarding_step, null);
  assertStringIncludes(reply.text, "Serhii");
});

Deno.test("onboarding: groqkey encrypts the key (v2) and finishes", async () => {
  const { sb, tenant } = setup({ name: "Serhii", onboarding_step: "groqkey" });
  const key = "gsk_" + "a".repeat(40);
  await advanceOnboarding({ sb, member, step: "groqkey", locale: "ru", text: key });
  const stored = tenant().groq_api_key as string;
  assertEquals(stored.startsWith("v2:"), true);
  assertEquals(await decryptSecret(sb, TENANT, stored), key);
  assertEquals(tenant().onboarding_step, null);
});
