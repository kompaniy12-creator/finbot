# STATE.md, текущее состояние работы

Этот файл обновляет Claude Code автоматически после каждого milestone и перед длинными операциями.

```yaml
status: in_progress
current_milestone: M0.5
last_completed_milestone: null
last_completed_step: ".env created, validator green (23/23)"
next_step: "Wait for user 'age-key-saved' confirmation, then start M1"
blockers:
  - waiting_user_confirm: "age-key-saved"
notes:
  - "Mode: shared-org on existing Supabase project Twoja Decyzja (ref: bltbuptzsswaislqagwe, eu-west-3)"
  - "Free-tier project limit (2/2) reached, cannot create separate finbot project"
  - "DB password NOT reset - bypassed via Management API query endpoint (POST /v1/projects/{ref}/database/query) for all SQL"
  - "Pre-flight: only blacklist tables exist (payouts/photos/promotions/referrals/transactions/users/withdrawals), no FinBot tables, safe to proceed"
  - "Whitelist FinBot tables to create in M2: family_members, categories, expenses, receipts, expense_audit, exchange_rates, recurring_expenses, anthropic_usage, backup_metadata, cron_jobs, migration_history, settings, message_log, pending_retry, media_group_buffer, system_health"
  - "BLACKLIST tables (NEVER drop/alter/truncate): payouts, photos, promotions, referrals, transactions, users, withdrawals"
  - "Telegram bot: @KSSfinance_bot (id 8628608360)"
  - "GitHub user: kompaniy12-creator"
  - "Age public key: age149tg8u7ez6ddx424ayzxk6nya4q2fkv57ejdc246c09sqhrxufxqvtt6c3"
todo_carry_over:
  - "When creating cron-backup (M15), MUST whitelist FinBot tables only (per CLAUDE.local.md)"
  - "M2 migrations: all CREATE statements must use IF NOT EXISTS, validate no DDL on blacklist tables"
  - "M1: adapt 'supabase link --password' workflow to operate without DB password (use Management API query for all SQL)"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-18T21:22:00Z
```
