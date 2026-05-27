import { assertEquals } from "@std/assert";
import { isTelegramIp } from "../supabase/functions/_shared/telegram_ip.ts";

Deno.test("isTelegramIp: 149.154.164.36 (mid of 149.154.160.0/20) -> true", () => {
  assertEquals(isTelegramIp("149.154.164.36"), true);
});

Deno.test("isTelegramIp: range edges 149.154.160.0 and 149.154.175.255 -> true", () => {
  assertEquals(isTelegramIp("149.154.160.0"), true);
  assertEquals(isTelegramIp("149.154.175.255"), true);
});

Deno.test("isTelegramIp: just outside 149.154/20 -> false", () => {
  assertEquals(isTelegramIp("149.154.159.255"), false);
  assertEquals(isTelegramIp("149.154.176.0"), false);
});

Deno.test("isTelegramIp: 91.108.5.10 (mid of 91.108.4.0/22) -> true", () => {
  assertEquals(isTelegramIp("91.108.5.10"), true);
});

Deno.test("isTelegramIp: just outside 91.108.4.0/22 -> false", () => {
  assertEquals(isTelegramIp("91.108.3.255"), false);
  assertEquals(isTelegramIp("91.108.8.0"), false);
});

Deno.test("isTelegramIp: arbitrary public IP -> false", () => {
  assertEquals(isTelegramIp("8.8.8.8"), false);
  assertEquals(isTelegramIp("1.1.1.1"), false);
  assertEquals(isTelegramIp("127.0.0.1"), false);
});

Deno.test("isTelegramIp: IPv4-mapped IPv6 in TG range -> true", () => {
  assertEquals(isTelegramIp("::ffff:149.154.164.36"), true);
});

Deno.test("isTelegramIp: plain IPv6 -> allowed (no published v6 ranges)", () => {
  assertEquals(isTelegramIp("2001:db8::1"), true);
});

Deno.test("isTelegramIp: bad input -> false", () => {
  assertEquals(isTelegramIp(""), false);
  assertEquals(isTelegramIp("not.an.ip"), false);
  assertEquals(isTelegramIp("1.2.3"), false);
  assertEquals(isTelegramIp("999.0.0.0"), false);
});
