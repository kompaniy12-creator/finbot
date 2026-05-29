import { assertEquals } from "@std/assert";
import { parseTip } from "../supabase/functions/_shared/tip_parse.ts";

Deno.test("parseTip: 'Чаевые 100 лек' -> 100 ALL", () => {
  const r = parseTip("Чаевые 100 лек");
  assertEquals(r?.amount, 100);
  assertEquals(r?.currency, "ALL");
});

Deno.test("parseTip: 'tip 5 EUR' -> 5 EUR", () => {
  const r = parseTip("tip 5 EUR");
  assertEquals(r?.amount, 5);
  assertEquals(r?.currency, "EUR");
});

Deno.test("parseTip: '100 leke tips' -> 100 ALL", () => {
  const r = parseTip("100 leke tips");
  assertEquals(r?.amount, 100);
  assertEquals(r?.currency, "ALL");
});

Deno.test("parseTip: '5.50 zł чаевые' -> 5.5 PLN", () => {
  const r = parseTip("5.50 zł чаевые");
  assertEquals(r?.amount, 5.5);
  assertEquals(r?.currency, "PLN");
});

Deno.test("parseTip: comma decimals '5,50 zł чаевые' -> 5.5 PLN", () => {
  const r = parseTip("5,50 zł чаевые");
  assertEquals(r?.amount, 5.5);
  assertEquals(r?.currency, "PLN");
});

Deno.test("parseTip: no tip word -> null", () => {
  assertEquals(parseTip("Уличные собаки"), null);
});

Deno.test("parseTip: tip word but no amount -> null", () => {
  assertEquals(parseTip("оставил чаевые"), null);
});

Deno.test("parseTip: currency missing -> null currency, caller falls back", () => {
  const r = parseTip("чаевые 200");
  assertEquals(r?.amount, 200);
  assertEquals(r?.currency, null);
});

Deno.test("parseTip: remainder preserves non-tip text", () => {
  const r = parseTip("чаевые 100 лек уличные собаки");
  assertEquals(r?.amount, 100);
  assertEquals(r?.currency, "ALL");
  // Both 'чаевые', '100', and 'лек' get stripped; 'уличные собаки' stays.
  // Word 'лек' is part of the ALL alias regex and disappears as a side effect.
  assertEquals(r?.remainder.includes("уличные собаки"), true);
});

Deno.test("parseTip: empty input -> null", () => {
  assertEquals(parseTip(""), null);
});
