# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M6
last_completed_milestone: M5
last_completed_step: "M5 done: claude.ts (callClaude+cost+caching) + budget.ts (2-tier daily) + 18 tests"
next_step: "M6: embedder via Supabase.ai gte-small + categorizer (kNN -> Claude fallback) + cron-retraining"
blockers: []
notes:
  - "Deployed Edge Functions: setup-once, cron-retry-failed, tg-webhook"
  - "Bot live, 6 commands working, webhook registered, BotFather menu configured"
  - "_shared modules: log, supabase, types, auth, cors, idempotency, retry, webhook_secret, budget, claude"
  - "Budget: per-user soft 0.30 USD warn-only, global hard 1.00 USD throws BudgetExceededError"
  - "Pricing: Haiku 4.5 input $0.80/MTok output $4.00, Sonnet 4.6 input $3.00 output $15.00 (cache reads/writes per SPEC §5)"
  - "callClaude: enforceBudget pre-check -> Anthropic create -> computeCost -> recordUsage. cachedSystem helper for prompt caching"
  - "Tests: 59 unit + 6 integration = 65 total, all green"
  - "Git: feat(ai): claude with two-tier budget -> main"
todo_carry_over:
  - "M6: implement embedder + categorizer + cron-retraining"
  - "M7: wire claude+categorizer+currency into tg-webhook text handler (also wire into cron-retry-failed reprocess)"
  - "M15 cron-backup MUST whitelist FinBot tables only"
  - "M16 CI/CD: deploy.yml needs DB password or rewrite to use --project-ref + Management API"
  - "M14: configure cron GUCs via Management API query"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T00:30:00Z
```
