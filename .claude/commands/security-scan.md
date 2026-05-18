---
description: Run security-auditor subagent on the current codebase.
---

Run security-auditor subagent. After it returns:

1. If overall=pass: report green, continue.
2. If overall=warnings: log medium/low findings to `docs/STATE.md` as todo_carry_over, continue
   current work.
3. If overall=critical: STOP current work. For each critical finding:
   - Apply the recommended_fix.
   - Re-run security-auditor.
4. If critical findings remain after fix attempt: this matches CLAUDE.md "Когда останавливаться" →
   escalate to user.
5. NO commit is made until critical findings are 0.
