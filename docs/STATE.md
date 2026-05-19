# STATE.md, текущее состояние работы

```yaml
status: done
current_milestone: DONE
last_completed_milestone: M18
last_completed_step: "tag v1.0.0 pushed"
next_step: null
blockers: []
notes:
  - "All 18 milestones complete"
  - "Tests: 139 unit + 6 integration = 145, all green (RUN_INTEGRATION=1 required for the 6 DB-backed ones)"
  - "Coverage: supabase/functions/ 82% functions (target 80% ✓), _shared/ 84.6% functions / 62.2% branches / 68.6% lines (line target 90% NOT met - see v1.1 backlog)"
  - "Deployed Edge Functions: tg-webhook, setup-once, cron-{retry-failed, retraining, auto-confirm, media-group-sweep, rates, recurring, retention, anomaly, backup}, api-{me, stats, transactions, categories, family, export, health, health-public}"
  - "Cron: 9 jobs registered + active (heartbeat, recurring, retention, retraining, anomaly, media-group-sweep, rates, auto-confirm, retry-failed). settings table holds functions_url + cron_secret (ALTER DATABASE app.* denied on managed Supabase, so we used a row-table workaround)"
  - "CI/CD: test.yml + deploy.yml both green. Deno pinned 2.7.14. Auto-revert PR job present with [no-auto-revert] guard"
  - "Telegram bot @KSSfinance_bot live. Webhook registered. BotFather commands + menu set"
  - "api-health-public = 200 (heartbeat live)"
  - "Backup safety gate active: cron-backup short-circuits with {ok:false, reason:'safety_gate'} until /health backup-confirm"
  - "Repo: kompaniy12-creator/finbot (private). main + tag v1.0.0 pushed"
todo_carry_over:
  - "GitHub Pages for private repo requires Pro ($4/mo). Mini App URL kompaniy12-creator.github.io/finbot/webapp/ NOT reachable on free plan. Options: public repo / Pro / Netlify"
  - "HEIC: detect+reject only in v1. Add magick-wasm conversion in v1.1"
  - "ALL currency: exchangerate.host v2 needs API key. Defer to v1.1 or switch provider"
  - "_shared/ line coverage below 90% target. v1.1: add more mocked-API tests for text_pipeline/voice_pipeline/photo_pipeline/cron-recurring/anomaly happy paths"
  - "cron-retry-failed reprocess() stub: in v1.1 wire to actual text_pipeline.processTextMessage by deserializing the payload field"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
final_report_sent: true
last_updated: 2026-05-19T05:30:00Z
```
