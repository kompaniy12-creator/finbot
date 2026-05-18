---
description: Start a milestone (M1-M18). Reads playbook, updates STATE.md.
argument-hint: <milestone number 1-18>
---

Start work on milestone M$ARGUMENTS.

Steps you take RIGHT NOW:

1. Read `docs/02_PLAYBOOK.md` section M$ARGUMENTS in full.
2. Read `docs/07_CHECKLISTS.md` section M$ARGUMENTS in full.
3. Verify pre-conditions:
   - Previous milestone closed in `docs/STATE.md`.
   - `git status` clean (no uncommitted changes).
   - `deno task test` green.
4. Update `docs/STATE.md`:
   - `current_milestone: M$ARGUMENTS`
   - `next_step: <first step from playbook>`
   - `last_updated: <now ISO>`
5. Begin execution of step 1 from the playbook.
6. Continue without further confirmation until the milestone is complete.

If pre-conditions fail: report the specific failure and stop. Do not start the milestone with broken
pre-conditions.

If M$ARGUMENTS does not exist (out of 1-18 range): report and stop.

Use the migration-writer, edge-function-builder, test-writer, prompt-engineer, webapp-builder
subagents as needed for parallel work.
