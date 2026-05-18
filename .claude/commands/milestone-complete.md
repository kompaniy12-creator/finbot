---
description: Verify acceptance criteria for current milestone, commit, push, advance.
---

Complete the current milestone.

Steps you take RIGHT NOW:

1. Read `docs/STATE.md` to find current milestone.
2. Read `docs/07_CHECKLISTS.md` for that milestone, walk through each checkbox.
3. For each unchecked item: either complete the work or list as a blocker.
4. Run quality gates:
   ```bash
   deno task fmt
   deno task lint
   deno task check
   deno task test
   ```
   All must be green. If any red, fix before proceeding.
5. Run security-auditor subagent for a quick scan.
6. Run coverage-checker subagent if past M3. Coverage must meet thresholds (functions >= 80%,
   _shared >= 90%).
7. If past M16: run spec-conformance-checker subagent for affected scope.
8. Run deploy-verifier subagent if changes affect deploy.
9. Commit using EXACT message from SPEC §16 / `docs/02_PLAYBOOK.md` for this milestone.
   - Pre-M16: commit directly to main, `git push origin main`.
   - Post-M16: create feature branch, `gh pr create --fill --squash`, wait `gh pr checks`, then
     `gh pr merge --squash --delete-branch --admin`.
10. Update `docs/STATE.md`:
    - `last_completed_milestone: M<N>`
    - `current_milestone: M<N+1>`
    - `last_completed_step: <commit subject>`
    - `last_updated: <now ISO>`
    - `next_step: <first step of M<N+1> from playbook>`
11. Send a short status to user (Russian, max 3 lines per CLAUDE.md section 6 format).
12. If not at M18: immediately invoke `/milestone-start <N+1>` (or just continue, same effect).
13. If at M18: send the FINAL REPORT per CLAUDE.md section 7.

NO confirmation prompts to user along the way. Per `docs/00_AUTONOMY.md` you have full authority.
