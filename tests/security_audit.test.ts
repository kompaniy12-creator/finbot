import { assertEquals } from "@std/assert";
import { makeMockSb } from "./helpers/mock_sb.ts";
import {
  recentEventCount,
  recordSecurityEvent,
} from "../supabase/functions/_shared/security_audit.ts";

// deno-lint-ignore no-explicit-any
type AnySb = any;

Deno.test("recordSecurityEvent inserts a scrubbed row", async () => {
  const sb = makeMockSb();
  await recordSecurityEvent(sb as AnySb, {
    actorTelegramId: 42,
    tenantId: "t1",
    action: "key_set",
    details: { provider: "anthropic", leaked: "sk-ant-" + "x".repeat(30) },
  });
  const rows = sb._store.security_audit ?? [];
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.action, "key_set");
  assertEquals(rows[0]!.actor_telegram_id, 42);
  // The secret in details was scrubbed before insert.
  const details = rows[0]!.details as Record<string, unknown>;
  assertEquals((details.leaked as string).includes("xxxx"), false);
  assertEquals((details.leaked as string).includes("[redacted]"), true);
});

Deno.test("recordSecurityEvent never throws on DB error", async () => {
  // sb whose insert rejects.
  const sb = {
    from() {
      return {
        insert() {
          return Promise.reject(new Error("db down"));
        },
      };
    },
  };
  // Should resolve, not throw.
  await recordSecurityEvent(sb as AnySb, { action: "webhook_auth_fail", result: "fail" });
});

Deno.test("recentEventCount counts matching rows", async () => {
  // Mock returns a fixed count via head/count select.
  let captured: { action?: string } = {};
  const sb = {
    from() {
      const b: Record<string, unknown> = {
        select() {
          return b;
        },
        eq(col: string, val: string) {
          if (col === "action") captured.action = val;
          return b;
        },
        gte() {
          return Promise.resolve({ count: 7, error: null });
        },
      };
      return b;
    },
  };
  const n = await recentEventCount(sb as AnySb, "webhook_auth_fail", 600_000);
  assertEquals(n, 7);
  assertEquals(captured.action, "webhook_auth_fail");
});
