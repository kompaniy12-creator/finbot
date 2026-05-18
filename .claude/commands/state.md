---
description: Print current STATE.md and recent git activity.
---

Show a snapshot of where the project is right now:

1. Print `docs/STATE.md` in full.
2. `git log --oneline -10`.
3. `git status` (clean or pending).
4. `gh run list --workflow=deploy.yml --limit=1 --json status,conclusion,headBranch` if `gh` is
   configured.
5. If past M2: `supabase functions list 2>/dev/null | head` to show deployed functions.
6. Summarize in 3-5 lines: where we are, last action, next action, any blockers.

Do not make changes. Read-only.
