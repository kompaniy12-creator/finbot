---
description: Prepare for context compact by snapshotting state.
---

You're approaching the context window limit (or just want to be safe). Snapshot state so the next
session can resume cleanly:

1. Run `/state` to see where we are.
2. Update `docs/STATE.md` with current position in MAXIMUM detail:
   - `current_milestone`
   - `last_completed_step`
   - `next_step` (specific, e.g., "Write tests/voice.test.ts test for 6-minute rejection")
   - `blockers`
   - `notes` (recent decisions, deviations from playbook, gotchas discovered)
   - `todo_carry_over` (anything deferred)
3. Commit any uncommitted but stable changes. Do NOT commit half-done features.
4. `git push`.
5. Report to user one short line: "Compact-ready at M<N>, next step: <step>."

After this, when the session resumes via `/resume`, no information is lost.
