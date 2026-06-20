// Unit tests for tg-webhook command handlers + router.
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditCommand,
  categoriesCommand,
  dashboardCommand,
  demoteCommand,
  grantCommand,
  healthCommand,
  helpCommand,
  revokeCommand,
  startCommand,
  unauthorizedReply,
  unsupportedReply,
} from "../supabase/functions/tg-webhook/commands.ts";
import {
  dispatch,
  parseCommand,
  refuseUnauthorized,
  routeCommand,
} from "../supabase/functions/tg-webhook/router.ts";
import type { FamilyMember, TelegramUpdate } from "../supabase/functions/_shared/types.ts";

const TENANT = "00000000-0000-0000-0000-000000000001";
const ADMIN: FamilyMember = {
  id: "fm-admin",
  tenant_id: TENANT,
  telegram_id: 1436806270,
  name: "Серхий",
  role: "admin",
  active: true,
  locale: "ru",
};
const MEMBER: FamilyMember = {
  id: "fm-member",
  tenant_id: TENANT,
  telegram_id: 1061823487,
  name: "Viktoriia",
  role: "member",
  active: true,
  locale: "ru",
};

// Minimal table mock that supports order().order() and head-count selects.
function mockSb(seed: Record<string, Array<Record<string, unknown>>>) {
  function tableBuilder(t: string) {
    const rows = seed[t] ?? [];
    let filtered = rows.slice();
    let _count = false;
    let _limit: number | undefined;
    const obj = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) _count = true;
        return obj;
      },
      eq(col: string, val: unknown) {
        // tenantDb auto-adds .eq("tenant_id", ...); the mock seeds are
        // single-tenant, so treat that filter as a no-op here.
        if (col === "tenant_id") return obj;
        filtered = filtered.filter((r) => r[col] === val);
        return obj;
      },
      order(col: string, opts: { ascending: boolean }) {
        filtered = [...filtered].sort((a, b) => {
          const va = String(a[col] ?? "");
          const vb = String(b[col] ?? "");
          return opts.ascending ? va.localeCompare(vb) : vb.localeCompare(va);
        });
        return obj;
      },
      limit(n: number) {
        _limit = n;
        filtered = filtered.slice(0, n);
        return obj;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(onFulfilled: (v: unknown) => unknown) {
        const payload = _count
          ? { count: filtered.length, error: null }
          : { data: filtered.slice(0, _limit ?? filtered.length), error: null };
        return Promise.resolve(payload).then(onFulfilled);
      },
    };
    return obj;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (t: string) => tableBuilder(t) } as any;
}

Deno.test("parseCommand: extracts /cmd and args", () => {
  assertEquals(parseCommand("/help"), { cmd: "help", args: "" });
  assertEquals(parseCommand("/audit abc-123"), {
    cmd: "audit",
    args: "abc-123",
  });
  assertEquals(parseCommand("/start@FinBot"), { cmd: "start", args: "" });
  assertEquals(parseCommand("/AUDIT  abc"), {
    cmd: "audit",
    args: "abc",
  }, "command lower-cased, multiple spaces ok");
  assertEquals(parseCommand("just text"), null);
  assertEquals(parseCommand(""), null);
  assertEquals(parseCommand(undefined), null);
});

Deno.test("startCommand: uses member name", () => {
  const r = startCommand(MEMBER);
  assertStringIncludes(r.text, "Viktoriia");
  assertStringIncludes(r.text, "FinBot");
});

Deno.test("helpCommand: shows admin section for admin only", () => {
  assertStringIncludes(helpCommand(ADMIN).text, "Для админа");
  assertEquals(helpCommand(MEMBER).text.includes("Для админа"), false);
});

Deno.test("dashboardCommand: returns web_app button", () => {
  const r = dashboardCommand();
  const btn = r.reply_markup!.inline_keyboard[0]![0]!;
  assertEquals(btn.text, "FinApp");
  assertStringIncludes(btn.web_app!.url, "github.io");
});

Deno.test("categoriesCommand: lists seeded categories with fallback marker", async () => {
  const sb = mockSb({
    categories: [
      { name: "Other", is_fallback: true },
      { name: "Groceries", is_fallback: false },
      { name: "Transport", is_fallback: false },
    ],
  });
  const r = await categoriesCommand(sb, TENANT);
  assertStringIncludes(r.text, "Категории (3)");
  assertStringIncludes(r.text, "Groceries");
  assertStringIncludes(r.text, "Other (fallback)");
});

Deno.test("healthCommand: shows system_health and today's count", async () => {
  const sb = mockSb({
    system_health: [
      {
        id: 1,
        last_seen: "2026-05-19T00:00:00Z",
        bot_version: "test",
        backup_key_confirmed: true,
      },
    ],
    expenses: [{ expense_date: new Date().toISOString().slice(0, 10) }],
  });
  const r = await healthCommand(sb, TENANT);
  assertStringIncludes(r.text, "last_seen");
  assertStringIncludes(r.text, "test");
  assertStringIncludes(r.text, "backup_confirmed: true");
  assertStringIncludes(r.text, "expenses today: 1");
});

Deno.test("auditCommand: refuses non-uuid", async () => {
  const sb = mockSb({});
  const r = await auditCommand(sb, TENANT, "not-a-uuid");
  assertStringIncludes(r.text, "Использование");
});

Deno.test("auditCommand: shows empty message for missing expense", async () => {
  const sb = mockSb({ expense_audit: [] });
  const r = await auditCommand(sb, TENANT, "11111111-2222-3333-4444-555555555555");
  assertStringIncludes(r.text, "Нет audit-записей");
});

Deno.test("auditCommand: lists 5 latest audit rows", async () => {
  const sb = mockSb({
    expense_audit: [
      {
        action: "insert",
        created_at: "2026-05-19T01",
        actor_telegram_id: 1,
        source: "text",
        expense_id: "11111111-2222-3333-4444-555555555555",
      },
      {
        action: "archive",
        created_at: "2026-05-19T02",
        actor_telegram_id: null,
        source: null,
        expense_id: "11111111-2222-3333-4444-555555555555",
      },
    ],
  });
  const r = await auditCommand(sb, TENANT, "11111111-2222-3333-4444-555555555555");
  assertStringIncludes(r.text, "Audit для 11111111");
  assertStringIncludes(r.text, "insert");
  assertStringIncludes(r.text, "archive");
});

Deno.test("routeCommand: admin command blocks non-admin", async () => {
  const sb = mockSb({});
  const r = await routeCommand({ sb, member: MEMBER }, "health", "");
  assertStringIncludes(r.text, "только админу");
});

Deno.test("routeCommand: unknown command suggests /help", async () => {
  const sb = mockSb({});
  const r = await routeCommand({ sb, member: ADMIN }, "wibble", "");
  assertStringIncludes(r.text, "/help");
});

Deno.test("routeCommand: stubbed late-milestone commands return placeholder", async () => {
  const sb = mockSb({});
  for (const cmd of ["recurring", "budget"]) {
    const r = await routeCommand({ sb, member: ADMIN }, cmd, "");
    assertStringIncludes(r.text, "позднем milestone");
  }
});

// Note: dispatch for non-command text now routes to text_pipeline (M7).
// We don't unit-test that path here because it would require mocking Anthropic
// + categorizer + currency; integration tests in tests/text_pipeline.test.ts
// cover the happy path.

Deno.test("dispatch: returns null for callback_query without message", async () => {
  const sb = mockSb({});
  const out = await dispatch({
    update: { update_id: 1 } as TelegramUpdate,
    member: ADMIN,
    sb,
  });
  assertEquals(out, null);
});

Deno.test("refuseUnauthorized: returns rejection text with chatId", () => {
  const out = refuseUnauthorized({
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 99, first_name: "Stranger" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "/start",
    },
  });
  assertEquals(out?.chatId, 555);
  assertStringIncludes(out!.reply.text, "@the_kompanii");
});

Deno.test("unsupportedReply and unauthorizedReply both return strings", () => {
  assertStringIncludes(unsupportedReply().text, "Пока умею");
  assertStringIncludes(unauthorizedReply().text, "@the_kompanii");
});

Deno.test("helpCommand: lists member-management commands for admin", () => {
  const t = helpCommand(ADMIN).text;
  assertStringIncludes(t, "/grant");
  assertStringIncludes(t, "/revoke");
  assertStringIncludes(t, "/members");
});

Deno.test("grantCommand: refuses missing telegram_id", async () => {
  const sb = mockSb({});
  const r = await grantCommand(sb, "", ADMIN);
  assertStringIncludes(r.text, "Использование");
});

Deno.test("grantCommand: refuses non-numeric id", async () => {
  const sb = mockSb({});
  const r = await grantCommand(sb, "abc Den", ADMIN);
  assertStringIncludes(r.text, "Использование");
});

Deno.test("revokeCommand: refuses self-revoke", async () => {
  const sb = mockSb({});
  const r = await revokeCommand(sb, String(ADMIN.telegram_id), ADMIN);
  assertStringIncludes(r.text, "самого себя");
});

Deno.test("revokeCommand: refuses missing id", async () => {
  const sb = mockSb({});
  const r = await revokeCommand(sb, "", ADMIN);
  assertStringIncludes(r.text, "Использование");
});

Deno.test("demoteCommand: refuses self-demote", async () => {
  const sb = mockSb({});
  const r = await demoteCommand(sb, String(ADMIN.telegram_id), ADMIN);
  assertStringIncludes(r.text, "хотя бы один админ");
});
