// Integration test for the expense_audit trigger (SPEC §4.4, M2 acceptance).
// Verifies that the trg_expense_audit trigger writes a row on:
//   - INSERT into expenses ('insert' action)
//   - UPDATE setting archived=true ('archive' action)
//   - UPDATE changing category_id ('recategorize' action)
//   - UPDATE on other fields ('update' action)
//
// Gated by RUN_INTEGRATION=1 because it talks to the live Supabase project.
// SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF must be in env (from .env).

import { assertEquals } from "@std/assert";
import { mgmtQuery, shouldRunIntegration } from "./helpers/mgmt_query.ts";

// Sentinel telegram_message_id for test isolation. Outside any realistic range.
const TEST_TGID = 9_999_999_001;

async function cleanup() {
  await mgmtQuery(`DELETE FROM expenses WHERE telegram_message_id = ${TEST_TGID}`);
}

interface IdRow {
  id: string;
}
interface AuditRow {
  action: string;
  source: string | null;
}

async function setup(): Promise<{ catId: string; otherCatId: string; fmId: string }> {
  const cat = await mgmtQuery<IdRow>(
    `SELECT id FROM categories WHERE name = 'Other' LIMIT 1`,
  );
  const otherCat = await mgmtQuery<IdRow>(
    `SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1`,
  );
  const fm = await mgmtQuery<IdRow>(
    `SELECT id FROM family_members WHERE role = 'admin' LIMIT 1`,
  );
  if (
    !cat.ok || !otherCat.ok || !fm.ok || !cat.rows?.length || !otherCat.rows?.length ||
    !fm.rows?.length
  ) {
    throw new Error("Setup failed: missing categories or family_members");
  }
  return {
    catId: cat.rows[0]!.id,
    otherCatId: otherCat.rows[0]!.id,
    fmId: fm.rows[0]!.id,
  };
}

Deno.test({
  name: "audit_trigger: insert -> audit('insert')",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, fmId } = await setup();
    const insert = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_insert', current_date, 1.00, 'PLN', 1.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    if (!insert.ok || !insert.rows?.length) throw new Error("insert failed: " + insert.error);

    const audit = await mgmtQuery<AuditRow>(
      `SELECT action, source FROM expense_audit
       WHERE expense_id = '${insert.rows[0]!.id}' ORDER BY created_at`,
    );
    assertEquals(audit.rows?.length, 1, "expected exactly 1 audit row after insert");
    assertEquals(audit.rows![0]!.action, "insert");
    assertEquals(audit.rows![0]!.source, "text");

    await cleanup();
  },
});

Deno.test({
  name: "audit_trigger: archive -> audit('archive')",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, fmId } = await setup();
    const insert = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_archive', current_date, 2.00, 'PLN', 2.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    const eid = insert.rows![0]!.id;
    await mgmtQuery(`UPDATE expenses SET archived=true WHERE id='${eid}'`);

    const audit = await mgmtQuery<AuditRow>(
      `SELECT action FROM expense_audit WHERE expense_id='${eid}' ORDER BY created_at`,
    );
    assertEquals(audit.rows?.length, 2);
    assertEquals(audit.rows![0]!.action, "insert");
    assertEquals(audit.rows![1]!.action, "archive");

    await cleanup();
  },
});

Deno.test({
  name: "audit_trigger: recategorize -> audit('recategorize')",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, otherCatId, fmId } = await setup();
    const insert = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_recat', current_date, 3.00, 'PLN', 3.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    const eid = insert.rows![0]!.id;
    await mgmtQuery(
      `UPDATE expenses SET category_id='${otherCatId}', corrected_by_user=true WHERE id='${eid}'`,
    );

    const audit = await mgmtQuery<AuditRow>(
      `SELECT action FROM expense_audit WHERE expense_id='${eid}' ORDER BY created_at`,
    );
    assertEquals(audit.rows?.length, 2);
    assertEquals(audit.rows![1]!.action, "recategorize");

    await cleanup();
  },
});

Deno.test({
  name: "audit_trigger: plain update -> audit('update')",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, fmId } = await setup();
    const insert = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_update', current_date, 4.00, 'PLN', 4.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    const eid = insert.rows![0]!.id;
    await mgmtQuery(`UPDATE expenses SET description='updated' WHERE id='${eid}'`);

    const audit = await mgmtQuery<AuditRow>(
      `SELECT action FROM expense_audit WHERE expense_id='${eid}' ORDER BY created_at`,
    );
    assertEquals(audit.rows?.length, 2);
    assertEquals(audit.rows![1]!.action, "update");

    await cleanup();
  },
});

Deno.test({
  name: "audit_trigger: idempotency unique constraint blocks duplicate insert",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, fmId } = await setup();
    const first = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_dup', current_date, 5.00, 'PLN', 5.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    assertEquals(first.ok, true);

    const dup = await mgmtQuery(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('audit_test_dup_again', current_date, 6.00, 'PLN', 6.00, '${catId}', '${fmId}', 'text', ${TEST_TGID}, 0) RETURNING id`,
    );
    // duplicate insert must fail on unique constraint
    assertEquals(dup.ok, false, "duplicate insert should have failed");

    await cleanup();
  },
});
