import { assertEquals } from "@std/assert";
import { checkSecret } from "../supabase/functions/_shared/webhook_secret.ts";

Deno.test("checkSecret: header secret_token (preferred path)", () => {
  const req = new Request("https://example.com/", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "mywebhooksecret" },
  });
  assertEquals(checkSecret(req, "mywebhooksecret"), true);
});

Deno.test("checkSecret: header mismatch -> false", () => {
  const req = new Request("https://example.com/", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
  });
  assertEquals(checkSecret(req, "mywebhooksecret"), false);
});

Deno.test("checkSecret: legacy URL secret accepted when bot token provided", () => {
  const req = new Request("https://example.com/?secret=mytoken123", {
    method: "POST",
  });
  assertEquals(checkSecret(req, "newsecret", "mytoken123"), true);
});

Deno.test("checkSecret: legacy URL secret rejected without bot-token arg", () => {
  const req = new Request("https://example.com/?secret=mytoken123", {
    method: "POST",
  });
  assertEquals(checkSecret(req, "newsecret"), false);
});

Deno.test("checkSecret: no secret -> false", () => {
  const req = new Request("https://example.com/", { method: "POST" });
  assertEquals(checkSecret(req, "expected"), false);
});

Deno.test("checkSecret: case-sensitive header", () => {
  const req = new Request("https://example.com/", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "ABC" },
  });
  assertEquals(checkSecret(req, "abc"), false);
});

Deno.test("checkSecret: empty webhook secret and no legacy -> false", () => {
  const req = new Request("https://example.com/", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "anything" },
  });
  assertEquals(checkSecret(req, ""), false);
});
