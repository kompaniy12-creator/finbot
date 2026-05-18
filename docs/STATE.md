# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M3
last_completed_milestone: M2
last_completed_step: "M2 done: 6 migrations applied via Management API, setup-once deployed and seeded (17 categories + 2 family members), audit trigger verified via 5 integration tests"
next_step: "M3: dedupe via message_log, pending_retry table flow, cron-retry-failed function, idempotency_edited test (mandatory edge case per SPEC §18.4)"
blockers: []
notes:
  - "Supabase: shared mode on Twoja Decyzja (ref bltbuptzsswaislqagwe, eu-west-3). No DB password."
  - "All SQL applied via POST /v1/projects/{ref}/database/query (scripts/apply_migration.sh). Safety guard refuses DDL on blacklist tables."
  - "12 FinBot tables created alongside 7 blacklist (payouts/photos/promotions/referrals/transactions/users/withdrawals - untouched)"
  - "17 categories with gte-small embeddings (1 fallback='Other'), 2 family_members (Серхий admin, Viktoriia member)"
  - "Triggers: trg_expense_audit fires AFTER INSERT/UPDATE on expenses. Tested for all 4 actions (insert/archive/recategorize/update)"
  - "Storage bucket 'receipts' private, 5MB limit, image/jpeg + image/png"
  - "Extensions enabled: uuid-ossp, vector, pg_trgm, pg_cron, pg_net"
  - "5 pg_cron jobs COMMENTED OUT in 0005_cron.sql until M14 (Edge Functions for them don't exist yet)"
  - "Supabase functions deploy needs '--import-map deno.json' (Makefile + deploy.yml updated)"
  - "CRITICAL fix from runtime test: zod@3.25.0 causes BOOT_ERROR in Supabase Edge runtime. Reverted to zod@3.23.8 (SPEC §11.2 default). Other SDK versions from v1.2 patches all verified working."
  - "Existing deployed function 'process-photo' (id cbd21b0a-...) in project: not ours, do not touch"
  - "GitHub repo: kompaniy12-creator/finbot (private), branch main"
  - "Tests: 5 unit + 5 integration (audit_trigger.test.ts), 10/10 passing"
  - "Test gate: RUN_INTEGRATION=1 + .env sourced runs DB tests"
todo_carry_over:
  - "M15 cron-backup MUST whitelist FinBot tables only (per CLAUDE.local.md)"
  - "M16 CI/CD: deploy.yml has 'supabase link --password' which needs DB password. Either provide it or rewrite to use --project-ref only. Currently kept as-is (will likely fail in CI until M16 resolution)"
  - "M14: configure cron GUCs (app.functions_url, app.cron_secret) via Management API query (no psql)"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-18T21:53:00Z
```
