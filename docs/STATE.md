# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M5
last_completed_milestone: M4
last_completed_step: "M4 done: tg-webhook with auth+dedupe+router deployed. Telegram webhook registered. 6 commands working. setMyCommands + Mini App menu button configured."
next_step: "M5: _shared/claude.ts with tool_use + prompt caching + cost tracking. _shared/budget.ts two-tier (per-user soft 0.30, global hard 1.00 USD/day). anthropic_usage inserts"
blockers: []
notes:
  - "Supabase project: bltbuptzsswaislqagwe. Deployed Edge Functions: setup-once, cron-retry-failed, tg-webhook (+ pre-existing process-photo not ours)"
  - "Telegram webhook live at https://bltbuptzsswaislqagwe.supabase.co/functions/v1/tg-webhook?secret=<token>"
  - "Bot @KSSfinance_bot: 8 commands registered (start/help/dashboard/history/stats/categories/undo/recurring), menu button -> mini app URL"
  - "Mini App URL (placeholder until M13 GitHub Pages deploy): https://kompaniy12-creator.github.io/finbot/webapp/"
  - "Auth flow: authorize() -> on null reject + notifyAdminText. Dedupe: only for non-command messages. Commands always responsive"
  - "Admin commands gated by member.role==='admin': /health, /audit <uuid>, /budget (placeholder)"
  - "Tests: 41 unit + 6 integration = 47 total, all green"
  - "Git: feat(auth): authorization and base commands -> main"
  - "M7+ commands (history/stats/undo/recurring/budget) currently return placeholder text"
todo_carry_over:
  - "M7: wire real text-pipeline into cron-retry-failed reprocess() (replace stub)"
  - "M15 cron-backup MUST whitelist FinBot tables only (per CLAUDE.local.md)"
  - "M16 CI/CD: deploy.yml has 'supabase link --password' which needs DB password. Will need reset-then-set OR rewrite to use --project-ref + Management API"
  - "M14: configure cron GUCs (app.functions_url, app.cron_secret) via Management API query"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T00:15:00Z
```
