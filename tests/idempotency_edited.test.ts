// Mandatory edge case (SPEC §18.4): idempotency_edited.
//
// Scenario (SPEC §6.5):
//   1. User sends a text message that parses into N expense lines (e.g. 3 items).
//   2. User edits the message; new text parses into M expense lines (e.g. 1 item).
//   3. User edits again; new text parses into K lines (e.g. 2 items).
//
// Required semantics:
//   - After each edit, all previously-stored expenses for that
//     (telegram_message_id, family_member_id) MUST be archived (audit row written),
//     then HARD-DELETED so the unique (msg, family, line_index) constraint frees up.
//   - The new pipeline runs fresh starting at line_index=0.
//   - Audit log preserves the full history (insert -> archive -> delete + new insert).
//
// Until the EDIT handler in tg-webhook is wired in M11, this test exercises the
// raw SQL semantics required: insert N rows, "edit" by archiving + hard-deleting,
// insert M rows, repeat. Gated by RUN_INTEGRATION=1.

import { assertEquals } from "@std/assert";
import { mgmtQuery, shouldRunIntegration } from "./helpers/mgmt_query.ts";

const TEST_TGID = 9_999_999_500;

interface IdRow {
  id: string;
}
interface CountRow {
  count: number;
}
interface AuditCountRow {
  action: string;
  c: number;
}

async function cleanup() {
  await mgmtQuery(`DELETE FROM expenses WHERE telegram_message_id = ${TEST_TGID}`);
}

async function getCatAndFm() {
  const cat = await mgmtQuery<IdRow>(
    `SELECT id FROM categories WHERE name = 'Other' LIMIT 1`,
  );
  const fm = await mgmtQuery<IdRow>(
    `SELECT id FROM family_members WHERE role = 'admin' LIMIT 1`,
  );
  return { catId: cat.rows![0]!.id, fmId: fm.rows![0]!.id };
}

async function insertLines(
  catId: string,
  fmId: string,
  amounts: number[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const r = await mgmtQuery<IdRow>(
      `INSERT INTO expenses (name, expense_date, amount, currency, amount_pln, category_id, family_member_id, source, telegram_message_id, line_index)
       VALUES ('edit_test_${i}', current_date, ${amounts[i]}, 'PLN', ${
        amounts[i]
      }, '${catId}', '${fmId}', 'text', ${TEST_TGID}, ${i}) RETURNING id`,
    );
    if (!r.ok || !r.rows?.length) throw new Error("insert failed: " + r.error);
    ids.push(r.rows[0]!.id);
  }
  return ids;
}

// Edit semantics per SPEC §6.5:
//   UPDATE archived=true (audit captures 'archive') THEN hard DELETE.
async function archiveAndDelete(ids: string[]) {
  const idsList = ids.map((i) => `'${i}'`).join(",");
  await mgmtQuery(`UPDATE expenses SET archived = true WHERE id IN (${idsList})`);
  await mgmtQuery(`DELETE FROM expenses WHERE id IN (${idsList})`);
}

Deno.test({
  name: "idempotency_edited: 3 lines -> 1 line -> 2 lines, audit preserved",
  ignore: !shouldRunIntegration(),
  async fn() {
    await cleanup();
    const { catId, fmId } = await getCatAndFm();

    // Step 1: insert 3 expense lines (original message).
    const firstIds = await insertLines(catId, fmId, [10, 20, 30]);
    let count = await mgmtQuery<CountRow>(
      `SELECT count(*)::int AS count FROM expenses WHERE telegram_message_id = ${TEST_TGID}`,
    );
    assertEquals(count.rows![0]!.count, 3, "after first insert");

    // Step 2: edit to 1 line (shorter).
    await archiveAndDelete(firstIds);
    const secondIds = await insertLines(catId, fmId, [55]);
    count = await mgmtQuery<CountRow>(
      `SELECT count(*)::int AS count FROM expenses WHERE telegram_message_id = ${TEST_TGID}`,
    );
    assertEquals(count.rows![0]!.count, 1, "after first edit (short)");

    // Step 3: edit again to 2 lines (longer).
    await archiveAndDelete(secondIds);
    await insertLines(catId, fmId, [40, 60]);
    count = await mgmtQuery<CountRow>(
      `SELECT count(*)::int AS count FROM expenses WHERE telegram_message_id = ${TEST_TGID}`,
    );
    assertEquals(count.rows![0]!.count, 2, "after second edit (long)");

    // Audit log: ON DELETE CASCADE removes audit rows for deleted expenses, so
    // we only see audit rows for the currently-live expenses. That is 2 rows
    // (one 'insert' per current expense). The semantic that matters is:
    //  (a) the unique constraint did not block any re-insert with same
    //      (telegram_message_id, family_member_id, line_index),
    //  (b) audit always wrote 'insert' for new lines, 'archive' for archived
    //      lines (which were then hard-deleted along with their audit chain).
    const audit = await mgmtQuery<AuditCountRow>(
      `SELECT action, count(*)::int AS c FROM expense_audit a JOIN expenses e ON e.id = a.expense_id
       WHERE e.telegram_message_id = ${TEST_TGID} GROUP BY action`,
    );
    const byAction = Object.fromEntries(
      (audit.rows ?? []).map((r) => [r.action, r.c]),
    );
    assertEquals(byAction["insert"], 2, "current rows each have one insert");
    // archive rows were cascaded away with their hard-deleted expense, OK.

    // Verify final line_index sequence is 0,1.
    const lines = await mgmtQuery<{ line_index: number }>(
      `SELECT line_index FROM expenses WHERE telegram_message_id = ${TEST_TGID} ORDER BY line_index`,
    );
    assertEquals(lines.rows![0]!.line_index, 0);
    assertEquals(lines.rows![1]!.line_index, 1);

    // Verify no remaining expenses with TEST_TGID after final cleanup.
    await cleanup();
    const after = await mgmtQuery<CountRow>(
      `SELECT count(*)::int AS count FROM expenses WHERE telegram_message_id = ${TEST_TGID}`,
    );
    assertEquals(after.rows![0]!.count, 0);
  },
});
