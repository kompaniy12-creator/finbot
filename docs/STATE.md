# STATE.md, текущее состояние работы

```yaml
status: active
current_milestone: "post-v1.0 feature development (~v1.2)"
last_completed_milestone: M18
last_completed_step: "fix(ci): lint no-inner-declarations in api-budgets, CI Test back to green"
next_step: null
blockers: []
notes:
  - "v1.0.0 (18 milestones) tagged 2026-05-19. С тех пор 97 коммитов с фичами поверх тега, ветка main."
  - "Разработка идёт прямо в main (быстрый соло-режим), не через feature-ветки. CI на каждый push: Test + Deploy."
  - "Тесты: 211 passed, 0 failed, 6 ignored (deno task test). Типы deno check чисто (125 файлов). Lint чист. Fmt чист (165 файлов)."
  - "Edge Functions: 35 (без _shared). Миграций: 26 (последняя 0027_credit_name_pattern)."
  - "Бэкенд live: api-health-public = ok. Бот @KSSfinance_bot, webhook зарегистрирован."
  - "Supabase project ref: bltbuptzsswaislqagwe. Репо: kompaniy12-creator/finbot (private)."
  - "Cron активны (из миграций): daily-summary 20:00 UTC, month-summary 07:00 UTC 1-го, notifications-daily 06:00 UTC, recurring-daily 07:00, retention-daily 02:30, retraining-weekly вс 03:00, anomaly-daily 08:00, media-group-sweep */2m, rates-daily 05:00, auto-confirm каждую минуту, retry-failed */5m."

features_since_v1_0:
  - "v1.1: conversational ask (AI-аналитик на данных FinBot, propose-confirm записи), magic-link web sessions, income tracking"
  - "Dashboard: family-wide видимость, KPI по исходной валюте, кастомные date-range, дефолт текущий месяц"
  - "Categories: CRUD из Mini App (admin), per-kind управление в settings"
  - "Access/members: запросы доступа, одно-тап approve/reject, grant/revoke/promote/demote, DM уведомления"
  - "Learning: непрерывное обучение, 3-band confidence, мгновенный retrain"
  - "Bank: PDF и screenshot пайплайн reconcile (Claude Sonnet + auto-match), авто-расходы из несматченных строк"
  - "Planning hub: planned payments CRUD, бюджеты на категории, платёжный календарь (planned+credit+debt на одной сетке)"
  - "Credits: вкладка с 9 типами долгов, auto-expense при платеже, pattern-based auto-debt, credit-for-someone -> auto debt, stats card"
  - "Debts: двусторонний учёт, auto expense/income при погашении, return-by-debt гасит связанный кредит, NL-запись долга текстом"
  - "Settings: профиль, тема, пользователи, сворачиваемые секции"
  - "Security: P1-P5 hardening pass"

todo_carry_over:
  - "GitHub Pages для private repo требует Pro ($4/mo). Mini App на free plan недоступен по github.io. Опции: public / Pro / Netlify. (в CI есть успешные pages-build-deployment, статус уточнить)"
  - "HEIC: detect+reject в v1. Конверсия magick-wasm отложена."
  - "ALL currency: exchangerate.host v2 требует API key. Отложено / сменить провайдера."
  - "_shared/ line coverage ниже целевых 90%. Добрать mocked-API тесты для pipelines."
  - "cron-retry-failed reprocess() заглушка: подключить к text_pipeline.processTextMessage через десериализацию payload."

family_members:
  - { name: "Серхий", telegram_id: 1436806270, role: "admin" }
  - { name: "Viktoriia", telegram_id: 1061823487, role: "member" }

last_updated: 2026-06-05
```
