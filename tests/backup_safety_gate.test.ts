// Tests for _shared/backup.ts safety gate + whitelist semantics.
import { assertEquals } from "@std/assert";
import { FINBOT_TABLES, isBackupConfirmed } from "../supabase/functions/_shared/backup.ts";

// deno-lint-ignore no-explicit-any
function mockSh(value: boolean | null): any {
  return {
    from(_t: string) {
      return {
        select(_c: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: value === null ? null : { backup_key_confirmed: value },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };
}

Deno.test("isBackupConfirmed: true when system_health flag is true", async () => {
  const sb = mockSh(true);
  assertEquals(await isBackupConfirmed(sb), true);
});

Deno.test("isBackupConfirmed: false when system_health flag is false", async () => {
  const sb = mockSh(false);
  assertEquals(await isBackupConfirmed(sb), false);
});

Deno.test("isBackupConfirmed: false when row missing", async () => {
  const sb = mockSh(null);
  assertEquals(await isBackupConfirmed(sb), false);
});

Deno.test("FINBOT_TABLES contains expected whitelist (no blacklist names)", () => {
  const blacklist = [
    "payouts",
    "photos",
    "promotions",
    "referrals",
    "transactions",
    "users",
    "withdrawals",
  ];
  for (const t of blacklist) {
    if ((FINBOT_TABLES as readonly string[]).includes(t)) {
      throw new Error(`FINBOT_TABLES leaks blacklist table: ${t}`);
    }
  }
  // Sanity: a few must-have entries
  for (const must of ["family_members", "categories", "expenses", "receipts"]) {
    if (!(FINBOT_TABLES as readonly string[]).includes(must)) {
      throw new Error(`FINBOT_TABLES missing required: ${must}`);
    }
  }
});

Deno.test("FINBOT_TABLES is frozen at 13 entries", () => {
  assertEquals(FINBOT_TABLES.length, 13);
});
