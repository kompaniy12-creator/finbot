# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M4
last_completed_milestone: M3
last_completed_step: "M3 done: retry.ts + cron-retry-failed deployed, 25/25 tests pass (19 unit + 6 integration including mandatory idempotency_edited)"
next_step: "M4: _shared/auth.ts whitelist (already partial), wire authorize() into tg-webhook, build commands /start /help /categories /dashboard /health /audit, unauthorized notify admin"
blockers: []
notes:
  - "Supabase project: bltbuptzsswaislqagwe (shared with Twoja Decyzja). All SQL via Management API query endpoint"
  - "Deployed Edge Functions: setup-once, cron-retry-failed (plus pre-existing process-photo which is not ours)"
  - "_shared modules ready: log, supabase, types, auth (with authorize+notifyAdmin), cors, idempotency (dedupe+markDone+markError), webhook_secret, retry (enqueueRetry+nextRetryAt+checkCronAuth+MAX_ATTEMPTS=5)"
  - "Backoff: [1, 5, 15, 60, 300] min, attempt_count 0->1->...->5 then giveup (next_retry_at pushed to year 9999)"
  - "cron-retry-failed reprocess() is a stub returning Promise.resolve(false) until M7 wires real pipeline. Cron will cycle pending_retry rows correctly through backoff"
  - "Mandatory edge case idempotency_edited verified: 3 lines -> archive+delete -> 1 line -> archive+delete -> 2 lines, line_index resets, unique constraint not violated"
  - "Tests: 25/25 (19 unit, 6 integration RUN_INTEGRATION=1)"
  - "Git: feat(reliability): idempotency and retry queue -> main"
todo_carry_over:
  - "M7: wire real text-pipeline into cron-retry-failed reprocess() (replace stub)"
  - "M15 cron-backup MUST whitelist FinBot tables only (per CLAUDE.local.md)"
  - "M16 CI/CD: deploy.yml has 'supabase link --password' which needs DB password. Will need reset-then-set, OR rewrite deploy.yml to use --project-ref + Management API approach"
  - "M14: configure cron GUCs (app.functions_url, app.cron_secret) via Management API query"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T00:01:00Z
```
