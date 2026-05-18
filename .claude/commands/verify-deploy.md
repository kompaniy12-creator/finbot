---
description: Run deploy-verifier subagent and act on findings.
---

Run the deploy-verifier subagent. After it returns:

1. If overall=ok: report green, continue normal work.
2. If overall=degraded: log to `docs/STATE.md` notes, continue. Mention to user briefly.
3. If overall=failed: spawn the troubleshooter subagent with the failure context. Apply the fix from
   troubleshooter report. Re-run deploy-verifier. If still failed after 2 retries: stop and ask user
   (matches CLAUDE.md "Когда останавливаться" condition 4).

NO confirmation prompts during the flow.
