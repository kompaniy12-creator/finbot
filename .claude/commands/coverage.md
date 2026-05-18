---
description: Run coverage analysis via coverage-checker subagent.
---

Run the coverage-checker subagent against the current codebase. After it returns:

1. If overall_pass=true: report green and continue normal work.
2. If overall_pass=false: for each file below threshold:
   - Spawn the test-writer subagent with that file + the suggested tests from the report.
   - Wait for test-writer to finish.
3. Re-run coverage-checker.
4. If still failing after 2 iterations: report what's left and stop, ask user if these branches are
   genuinely untestable.

NO confirmation prompts.
