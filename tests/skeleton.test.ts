import { assertEquals } from "@std/assert";
import { checkSecret } from "../supabase/functions/_shared/webhook_secret.ts";

Deno.test("checkSecret: returns true for matching secret", () => {
  const req = new Request("https://example.com/?secret=mytoken123", {
    method: "POST",
  });
  assertEquals(checkSecret(req, "mytoken123"), true);
});

Deno.test("checkSecret: returns false for wrong secret", () => {
  const req = new Request("https://example.com/?secret=bad", {
    method: "POST",
  });
  assertEquals(checkSecret(req, "expected"), false);
});

Deno.test("checkSecret: returns false when secret is missing", () => {
  const req = new Request("https://example.com/", { method: "POST" });
  assertEquals(checkSecret(req, "expected"), false);
});

Deno.test("checkSecret: case-sensitive comparison", () => {
  const req = new Request("https://example.com/?secret=ABC", {
    method: "POST",
  });
  assertEquals(checkSecret(req, "abc"), false);
});

Deno.test("checkSecret: rejects when expected is empty", () => {
  const req = new Request("https://example.com/?secret=anything", {
    method: "POST",
  });
  assertEquals(checkSecret(req, ""), false);
});
