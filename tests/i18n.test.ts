import { assertEquals, assertStringIncludes } from "@std/assert";
import { isLocale, LOCALE_ENGLISH_NAME, LOCALES, type Locale, t } from "../supabase/functions/_shared/i18n.ts";

const KEYS = [
  "choose_lang",
  "ask_name",
  "ask_apikey",
  "bad_apikey",
  "ask_groqkey",
  "bad_groqkey",
  "skip_btn",
  "done",
  "done_nogroq",
];

Deno.test("i18n: every locale defines every key", () => {
  for (const { code } of LOCALES) {
    for (const key of KEYS) {
      const s = t(code, key);
      assertEquals(typeof s, "string");
      // Not falling back to the raw key name (would mean a missing string).
      assertEquals(s === key, false, `missing ${key} for ${code}`);
    }
  }
});

Deno.test("i18n: {name} placeholder is substituted", () => {
  for (const { code } of LOCALES) {
    const s = t(code, "ask_apikey", { name: "Serhii" });
    assertStringIncludes(s, "Serhii");
    assertEquals(s.includes("{name}"), false);
  }
});

Deno.test("i18n: unknown locale falls back to Russian", () => {
  assertEquals(t("xx", "skip_btn"), t("ru", "skip_btn"));
});

Deno.test("i18n: unknown key returns the key itself", () => {
  assertEquals(t("en", "no_such_key"), "no_such_key");
});

Deno.test("isLocale recognizes the four supported codes only", () => {
  for (const c of ["uk", "ru", "pl", "en"]) assertEquals(isLocale(c), true);
  for (const c of ["de", "fr", "", "EN"]) assertEquals(isLocale(c), false);
});

Deno.test("LOCALE_ENGLISH_NAME covers all locales", () => {
  for (const { code } of LOCALES) {
    const name = LOCALE_ENGLISH_NAME[code as Locale];
    assertEquals(typeof name, "string");
  }
});
