// Unit tests for _shared/groq.ts (languageAllowed + maxDurationSec)
// and the voice helpers exposed for testing.

import { assertEquals } from "@std/assert";
import { languageAllowed, maxDurationSec, transcribe } from "../supabase/functions/_shared/groq.ts";

Deno.test("languageAllowed: default whitelist ru/uk/pl/en", () => {
  Deno.env.delete("WHISPER_LANGUAGES_WHITELIST");
  assertEquals(languageAllowed("ru"), true);
  assertEquals(languageAllowed("uk"), true);
  assertEquals(languageAllowed("pl"), true);
  assertEquals(languageAllowed("en"), true);
  assertEquals(languageAllowed("de"), false);
  assertEquals(languageAllowed("zh"), false);
});

Deno.test("languageAllowed: maps Groq's full names to ISO codes", () => {
  Deno.env.delete("WHISPER_LANGUAGES_WHITELIST");
  assertEquals(languageAllowed("russian"), true);
  assertEquals(languageAllowed("ukrainian"), true);
  assertEquals(languageAllowed("polish"), true);
  assertEquals(languageAllowed("english"), true);
  assertEquals(languageAllowed("czech"), false);
  assertEquals(languageAllowed("german"), false);
});

Deno.test("languageAllowed: case-insensitive", () => {
  assertEquals(languageAllowed("RU"), true);
  assertEquals(languageAllowed("En"), true);
});

Deno.test("languageAllowed: env override", () => {
  Deno.env.set("WHISPER_LANGUAGES_WHITELIST", "pl");
  assertEquals(languageAllowed("ru"), false);
  assertEquals(languageAllowed("pl"), true);
  Deno.env.delete("WHISPER_LANGUAGES_WHITELIST");
});

Deno.test("maxDurationSec: default 300", () => {
  Deno.env.delete("WHISPER_MAX_VOICE_DURATION_SEC");
  assertEquals(maxDurationSec(), 300);
});

Deno.test("maxDurationSec: env override parsed as number", () => {
  Deno.env.set("WHISPER_MAX_VOICE_DURATION_SEC", "120");
  assertEquals(maxDurationSec(), 120);
  Deno.env.delete("WHISPER_MAX_VOICE_DURATION_SEC");
});

Deno.test("transcribe: throws if GROQ_API_KEY missing", async () => {
  const saved = Deno.env.get("GROQ_API_KEY");
  Deno.env.delete("GROQ_API_KEY");
  let caught: Error | null = null;
  try {
    await transcribe(new Uint8Array([1, 2, 3]));
  } catch (e) {
    caught = e as Error;
  }
  if (saved) Deno.env.set("GROQ_API_KEY", saved);
  if (!caught) throw new Error("expected throw");
  assertEquals(caught.message.includes("GROQ_API_KEY"), true);
});

Deno.test("transcribe: builds multipart with model + audio, parses JSON response", async () => {
  const saved = Deno.env.get("GROQ_API_KEY");
  Deno.env.set("GROQ_API_KEY", "test-key-12345");
  const original = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (input) => {
    capturedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({ text: "купил кофе", language: "ru", duration: 2.4 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
  try {
    const r = await transcribe(new Uint8Array([1, 2, 3, 4]), { language: "auto" });
    assertEquals(r.text, "купил кофе");
    assertEquals(r.language, "ru");
    assertEquals(r.duration, 2.4);
    assertEquals(capturedUrl.includes("api.groq.com"), true);
  } finally {
    globalThis.fetch = original;
    if (saved) Deno.env.set("GROQ_API_KEY", saved);
    else Deno.env.delete("GROQ_API_KEY");
  }
});

Deno.test("transcribe: non-200 throws with status in message", async () => {
  Deno.env.set("GROQ_API_KEY", "test-key");
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("bad", { status: 500 }));
  let caught: Error | null = null;
  try {
    await transcribe(new Uint8Array([1, 2, 3]));
  } catch (e) {
    caught = e as Error;
  } finally {
    globalThis.fetch = original;
    Deno.env.delete("GROQ_API_KEY");
  }
  if (!caught) throw new Error("expected throw");
  assertEquals(caught.message.includes("500"), true);
});
