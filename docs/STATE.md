# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M7
last_completed_milestone: M6
last_completed_step: "M6 done: embedder + categorizer + cron-retraining deployed. 68 unit + 6 integration tests"
next_step: "M7: dates.ts (TZ-aware), currency.ts (NBP + exchangerate.host + fallback), wire text pipeline (claude+embedder+categorizer+currency) into tg-webhook, callbacks (undo/cat_menu/cat_set), commands history/stats/undo, cron-rates daily"
blockers: []
notes:
  - "Deployed Edge Functions: setup-once, cron-retry-failed, cron-retraining, tg-webhook"
  - "Bot @KSSfinance_bot live: 6 commands work, webhook live"
  - "_shared modules: log, supabase, types, auth, cors, idempotency, retry, webhook_secret, budget, claude, embedder, categorizer"
  - "Categorizer: kNN threshold 0.85, top 5 RPC results. Fallback uses top 30 categories + top 5 similar examples. New cat insert with English embedding"
  - "Retraining (cron): for each non-fallback category with >=3 corrected expenses, recompute centroid as mean(embeddings)"
  - "Tests: 68 unit + 6 integration = 74 total, all green"
  - "Git commits: chore: skeleton (d23a04f), feat(db) (f89083b), feat(reliability) (96cfb94), feat(auth) (46eeffb), feat(ai) claude (e2f7fc2)"
todo_carry_over:
  - "M7: replace cron-retry-failed reprocess() stub with real text pipeline"
  - "M15 cron-backup MUST whitelist FinBot tables only"
  - "M16 CI/CD: deploy.yml needs DB password or rewrite"
  - "M14: configure cron GUCs via Management API query, write 0008_cron_activate.sql"
  - "Categorizer needs FallbackResolver wired to Claude (parse_expense prompt) in M7"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T00:45:00Z
```
