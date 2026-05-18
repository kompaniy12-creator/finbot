# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M8
last_completed_milestone: M7
last_completed_step: "M7 done: text pipeline live. Bot can now parse expenses via Claude + categorize + currency convert + insert. /history /undo /stats commands working. callbacks (undo/catmenu/catset). cron-rates deployed (EUR/USD ok, ALL needs API key in v2)"
next_step: "M8: Groq Whisper voice transcription. _shared/groq.ts. Voice handler with duration pre-check, language whitelist, edit-message progress UI"
blockers: []
notes:
  - "Deployed: setup-once, cron-retry-failed, cron-retraining, cron-rates, tg-webhook (+ pre-existing process-photo not ours)"
  - "Bot @KSSfinance_bot fully alive: 9 commands working (start/help/dashboard/categories/health/audit + history/stats/undo)"
  - "Text pipeline: Claude Haiku 4.5 parse_expense -> gte-small embed -> kNN @0.85 or Claude categorize fallback -> NBP/exchangerate.host currency -> insert. high-amount (>200 PLN) sets needs_confirmation"
  - "Callbacks: undo (10min window), catmenu (top-5+pagination), catset (corrected_by_user=true)"
  - "cron-rates: EUR=4.2434, USD=3.6451 PLN today. ALL: exchangerate.host requires API key in v2, deferred to v1.1"
  - "M3 cron-retry-failed reprocess() still a stub (won't actually re-process). To wire properly need refactor"
  - "Tests: 89 unit + 6 integration = 95 total, all green"
todo_carry_over:
  - "ALL currency: exchangerate.host v2 needs free API key, sign up at exchangerate.host. Or switch to another provider. v1.1 fix"
  - "cron-retry-failed reprocess() stub: extract text pipeline into a callable shape it can invoke"
  - "M11: edited message handler (full archive+delete+reinsert pipeline)"
  - "M15 cron-backup MUST whitelist FinBot tables only"
  - "M16 CI/CD: deploy.yml needs DB password or rewrite to --project-ref + Management API"
  - "M14: cron schedules activation migration 0008_cron_activate.sql + GUC setting"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T01:00:00Z
```
