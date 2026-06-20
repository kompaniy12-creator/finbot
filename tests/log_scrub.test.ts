// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertStringIncludes } from "@std/assert";
import { scrub } from "../supabase/functions/_shared/log.ts";

Deno.test("scrub: redacts Anthropic / Groq keys in any field", () => {
  const out = scrub({
    note: "my key is sk-ant-api03-" + "x".repeat(40),
    groq: "gsk_" + "y".repeat(40),
  });
  assertEquals((out.note as string).includes("xxxx"), false);
  assertStringIncludes(out.note as string, "sk-ant-[redacted]");
  assertStringIncludes(out.groq as string, "gsk_[redacted]");
});

Deno.test("scrub: masks values under sensitive field names", () => {
  const out = scrub({ anthropic_api_key: "sk-ant-abcdef000111", token: "1234567890abcdef" });
  assertEquals((out.anthropic_api_key as string).includes("abcdef"), false);
  assertStringIncludes(out.anthropic_api_key as string, "***");
  assertStringIncludes(out.token as string, "***");
});

Deno.test("scrub: redacts v1/v2 ciphertext and bot tokens", () => {
  const out = scrub({
    stored: "v2:dek1:" + "A".repeat(20) + ":" + "B".repeat(20) + ":" + "C".repeat(20),
    legacy: "v1:" + "Z".repeat(40),
    webhook: "1234567890:AAAA" + "B".repeat(31), // synthetic, not a real token
  });
  assertStringIncludes(out.stored as string, "[encrypted]");
  assertStringIncludes(out.legacy as string, "[encrypted]");
  assertStringIncludes(out.webhook as string, "[bot-token]");
});

Deno.test("scrub: recurses into nested objects and arrays", () => {
  const out = scrub({
    user: { profile: { note: "sk-ant-" + "q".repeat(30) } },
    items: ["gsk_" + "w".repeat(30), "ok"],
  });
  const nested = (out.user as any).profile.note as string;
  assertStringIncludes(nested, "[redacted]");
  assertStringIncludes((out.items as string[])[0]!, "[redacted]");
  assertEquals((out.items as string[])[1]!, "ok");
});

Deno.test("scrub: truncates very long strings", () => {
  const out = scrub({ body: "a".repeat(2000) });
  assertStringIncludes(out.body as string, "[truncated]");
  assertEquals((out.body as string).length < 600, true);
});

Deno.test("scrub: leaves ordinary values intact", () => {
  const out = scrub({ amount: 100, currency: "PLN", name: "coffee" });
  assertEquals(out.amount, 100);
  assertEquals(out.currency, "PLN");
  assertEquals(out.name, "coffee");
});
