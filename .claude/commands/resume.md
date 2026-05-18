---
description: Resume work from STATE.md after session restart or context compact.
---

You are resuming work, possibly after a session restart or context compact.

Steps:

1. Read `CLAUDE.md` (skim if you remember, full read if context is fresh).
2. Read `docs/STATE.md` to find current position.
3. Verify state via subagent: invoke deploy-verifier (read-only) to confirm reality matches
   STATE.md.
4. If reality matches STATE.md: proceed with `next_step` from STATE.md immediately.
5. If reality drifts from STATE.md:
   - List the drifts (e.g., "STATE says M7 done, but webhook function not deployed").
   - Decide: trust git history > trust STATE.md. Reconstruct STATE.md from `git log` if needed.
   - Apply patches to reach the position implied by git.
   - Then proceed.

NO confirmation prompts. Per `docs/00_AUTONOMY.md` you have full authority to reconstruct state and
continue.
