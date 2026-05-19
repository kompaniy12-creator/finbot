# STATE.md, текущее состояние работы

```yaml
status: in_progress
current_milestone: M18
last_completed_milestone: M17
last_completed_step: "M16 CI live (test + deploy both green). M17 DR runbook in README"
next_step: "Coverage check, final commit docs, tag v1.0.0"
blockers: []
notes:
  - "16/18 done. 145 tests."
  - "Deployed: setup-once, cron-{retry-failed, retraining, auto-confirm, media-group-sweep, rates, recurring, retention, anomaly, backup}, tg-webhook, api-{me,stats,transactions,categories,family,export,health,health-public}"
  - "Cron: 9 jobs active. settings table holds functions_url + cron_secret (GUC permission denied)"
  - "CI/CD: test.yml + deploy.yml green. Deno pinned 2.7.14. Auto-revert PR job in place"
  - "Bot @KSSfinance_bot live: 9 commands + voice + photo + media groups + edited + high-amount + callbacks. Webhook registered, BotFather menu set"
  - "api-health-public = 200 (heartbeat live)"
  - "Backup safety gate active: cron-backup returns {ok:false,reason:safety_gate} until /health backup-confirm"
todo_carry_over:
  - "GitHub Pages for private repo requires Pro ($4/mo). Mini App URL not reachable. Options: public repo / pay / Netlify"
  - "HEIC: detect+reject only in v1. Add magick-wasm conversion in v1.1"
  - "ALL currency: exchangerate.host v2 needs key. Defer to v1.1"
family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }
last_updated: 2026-05-19T05:25:00Z
```
