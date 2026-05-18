// Unit tests for _shared/auth.ts authorize() + notifyAdmin().
import { assertEquals } from "@std/assert";
import { authorize, notifyAdmin } from "../supabase/functions/_shared/auth.ts";

function mockSb(rows: Array<Record<string, unknown>>) {
  const builder = {
    select(_cols: string) {
      return builder;
    },
    eq(_col: string, _val: unknown) {
      const filters: Array<[string, unknown]> = [[_col, _val]];
      return {
        eq(c2: string, v2: unknown) {
          filters.push([c2, v2]);
          return {
            maybeSingle() {
              const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
              return Promise.resolve({ data: match ?? null, error: null });
            },
          };
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { from: (_t: string) => builder } as any;
}

Deno.test("authorize: returns FamilyMember for active whitelisted telegram_id", async () => {
  const sb = mockSb([
    {
      id: "fm-1",
      telegram_id: 1436806270,
      name: "Серхий",
      role: "admin",
      active: true,
    },
  ]);
  const m = await authorize(1436806270, sb);
  assertEquals(m?.name, "Серхий");
  assertEquals(m?.role, "admin");
});

Deno.test("authorize: returns null for unknown telegram_id", async () => {
  const sb = mockSb([]);
  const m = await authorize(99999, sb);
  assertEquals(m, null);
});

Deno.test("authorize: returns null when active=false", async () => {
  const sb = mockSb([
    {
      id: "fm-2",
      telegram_id: 555,
      name: "Old",
      role: "member",
      active: false,
    },
  ]);
  const m = await authorize(555, sb);
  assertEquals(m, null);
});

Deno.test("notifyAdmin: calls bot.api.sendMessage with admin id from env", async () => {
  Deno.env.set("TELEGRAM_ADMIN_TELEGRAM_ID", "777");
  const captured: Array<{ id: number; text: string }> = [];
  const bot = {
    api: {
      sendMessage: (id: number, text: string) => {
        captured.push({ id, text });
        return Promise.resolve();
      },
    },
  };
  await notifyAdmin(bot, "test message");
  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.id, 777);
  assertEquals(captured[0]!.text, "test message");
  Deno.env.delete("TELEGRAM_ADMIN_TELEGRAM_ID");
});

Deno.test("notifyAdmin: is a noop when env var missing", async () => {
  Deno.env.delete("TELEGRAM_ADMIN_TELEGRAM_ID");
  let called = false;
  const bot = {
    api: {
      sendMessage: () => {
        called = true;
        return Promise.resolve();
      },
    },
  };
  await notifyAdmin(bot, "test");
  assertEquals(called, false);
});

Deno.test("notifyAdmin: swallows sendMessage errors", async () => {
  Deno.env.set("TELEGRAM_ADMIN_TELEGRAM_ID", "777");
  const bot = {
    api: {
      sendMessage: () => Promise.reject(new Error("network down")),
    },
  };
  // Should not throw
  await notifyAdmin(bot, "test");
  Deno.env.delete("TELEGRAM_ADMIN_TELEGRAM_ID");
});
