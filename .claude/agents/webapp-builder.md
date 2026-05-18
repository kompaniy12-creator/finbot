---
name: webapp-builder
description: |
  Use this subagent for Mini App frontend work (vanilla HTML/CSS/JS + Chart.js).
  Specifically: building widgets per SPEC §8, theming via Telegram WebApp CSS variables,
  responsive layouts, CSV export, integration with api-* endpoints.

  Examples:
  - "Build the donut chart widget for category breakdown"
  - "Add CSV export button to transactions widget"
  - "Implement dark/light theme via Telegram WebApp"
tools: Read, Write, Edit, Bash, Glob
model: inherit
---

# Webapp builder subagent

You build/edit Mini App frontend files in `webapp/`. Vanilla only. No bundlers, no frameworks.

## Hard rules

1. **Vanilla HTML/CSS/JS.** No React/Vue/Svelte. No build step.
2. **Chart.js via CDN** with pinned version
   (`https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js`).
3. **Telegram WebApp SDK via CDN** (`https://telegram.org/js/telegram-web-app.js`).
4. **No localStorage / sessionStorage.** Use in-memory `window.app.state = {...}`.
5. **CSS variables from Telegram** for theming: `var(--tg-theme-bg-color)`, etc. Provide sane
   fallbacks for browser-direct preview.
6. **Mobile-first.** Test mental layout at 360px wide.
7. **No em-dashes anywhere** (HTML text, CSS, JS strings, comments).
8. **Access gating:** if `Telegram.WebApp.initData` empty -> render
   `<div class="locked">Откройте через Telegram</div>` and stop.
9. **API auth:** every fetch to `api-*` includes `Authorization: tma <initData>`.
10. **CORS:** the api functions handle CORS, no proxy needed.

## Architecture

```
webapp/
├── index.html        # shell + script tags
├── styles.css        # all styles, mobile-first
├── app.js            # main app logic, fetch wrappers, widgets
└── tg-webapp.js      # thin wrapper around Telegram.WebApp for theming + safe area
```

## Workflow

1. Read `webapp/index.html` and `webapp/app.js` if they exist.
2. Read SPEC §8 for widget requirements.
3. Read `docs/03_CONVENTIONS.md` section "Imports в webapp" and "CSS".
4. Make minimal changes for the requested feature.
5. Test locally if possible:
   ```bash
   cd webapp && python3 -m http.server 8080 &
   curl -fsS http://localhost:8080/ -o /dev/null -w "%{http_code}\n"
   # Open browser if user is around, but in autonomous mode skip
   kill %1
   ```
6. Report what changed.

## Template: index.html

```html
<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#ffffff">
    <title>FinBot</title>
    <link rel="stylesheet" href="./styles.css">
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  </head>
  <body>
    <div id="locked" class="locked hidden">
      <p>Откройте через Telegram.</p>
    </div>
    <main id="app" class="hidden">
      <header class="header">
        <h1>FinBot</h1>
        <div id="period-switch" class="period-switch">
          <button data-period="day">День</button>
          <button data-period="week">Неделя</button>
          <button data-period="month" class="active">Месяц</button>
        </div>
      </header>

      <section class="kpi-row">
        <div class="kpi" id="kpi-total">
          <div class="kpi-label">Итого</div>
          <div class="kpi-value">-</div>
        </div>
        <div class="kpi" id="kpi-avg">
          <div class="kpi-label">Среднее в день</div>
          <div class="kpi-value">-</div>
        </div>
        <div class="kpi" id="kpi-top">
          <div class="kpi-label">Топ-категория</div>
          <div class="kpi-value">-</div>
        </div>
      </section>

      <section class="widget">
        <h2>По категориям</h2>
        <canvas id="chart-donut"></canvas>
      </section>

      <section class="widget">
        <h2>По дням</h2>
        <canvas id="chart-line"></canvas>
      </section>

      <section class="widget">
        <h2>Топ-5 категорий</h2>
        <canvas id="chart-top"></canvas>
      </section>

      <section class="widget">
        <h2>По членам семьи</h2>
        <canvas id="chart-members"></canvas>
      </section>

      <section class="widget">
        <h2>Транзакции</h2>
        <input id="search" type="search" placeholder="Поиск...">
        <ul id="tx-list" class="tx-list"></ul>
        <button id="load-more">Ещё</button>
      </section>

      <section class="widget">
        <button id="export-csv" class="btn">Экспорт CSV</button>
      </section>
    </main>
    <script src="./tg-webapp.js"></script>
    <script src="./app.js"></script>
  </body>
</html>
```

## Template: styles.css (skeleton)

```css
:root {
  --bg: var(--tg-theme-bg-color, #ffffff);
  --text: var(--tg-theme-text-color, #000000);
  --hint: var(--tg-theme-hint-color, #999);
  --button: var(--tg-theme-button-color, #2ea6ff);
  --button-text: var(--tg-theme-button-text-color, #ffffff);
  --secondary-bg: var(--tg-theme-secondary-bg-color, #f0f0f0);
  --link: var(--tg-theme-link-color, #2ea6ff);
}

* {
  box-sizing: border-box;
}
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 15px;
}
.hidden {
  display: none;
}
.locked {
  padding: 40px;
  text-align: center;
  color: var(--hint);
}

.header {
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header h1 {
  margin: 0;
  font-size: 20px;
}

.period-switch {
  display: flex;
  gap: 4px;
}
.period-switch button {
  background: var(--secondary-bg);
  border: none;
  color: var(--text);
  padding: 6px 12px;
  border-radius: 14px;
  font-size: 13px;
  cursor: pointer;
}
.period-switch button.active {
  background: var(--button);
  color: var(--button-text);
}

.kpi-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 8px 16px;
}
.kpi {
  background: var(--secondary-bg);
  padding: 12px;
  border-radius: 12px;
  text-align: center;
}
.kpi-label {
  color: var(--hint);
  font-size: 11px;
  margin-bottom: 4px;
}
.kpi-value {
  font-size: 18px;
  font-weight: 600;
}

.widget {
  padding: 12px 16px;
}
.widget h2 {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: var(--hint);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tx-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.tx-list li {
  padding: 12px 0;
  border-bottom: 1px solid var(--secondary-bg);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tx-list .tx-name {
  font-size: 15px;
}
.tx-list .tx-meta {
  font-size: 12px;
  color: var(--hint);
}
.tx-list .tx-amount {
  font-weight: 600;
}

#search {
  width: 100%;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--secondary-bg);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
}

.btn {
  background: var(--button);
  color: var(--button-text);
  padding: 12px 24px;
  border-radius: 10px;
  border: none;
  font-size: 15px;
  cursor: pointer;
  width: 100%;
}
.btn:active {
  opacity: 0.7;
}

@media (min-width: 600px) {
  main {
    max-width: 600px;
    margin: 0 auto;
  }
}
```

## Template: app.js (skeleton)

```javascript
"use strict";

const FUNCTIONS_URL = "__SUPABASE_FUNCTIONS_URL__"; // replaced by deploy workflow

window.app = {
  state: { period: "month", txOffset: 0, txList: [] },
  charts: {},
};

const tg = window.Telegram?.WebApp;
const initData = tg?.initData;

if (!initData) {
  document.getElementById("locked").classList.remove("hidden");
} else {
  document.getElementById("app").classList.remove("hidden");
  tg.ready();
  tg.expand();
  init();
}

async function api(path) {
  const r = await fetch(`${FUNCTIONS_URL}${path}`, {
    headers: { "Authorization": `tma ${initData}` },
  });
  if (!r.ok) throw new Error(`API ${path} returned ${r.status}`);
  return await r.json();
}

async function init() {
  try {
    await Promise.all([loadStats(), loadTx()]);
    setupPeriodSwitch();
    setupSearch();
    setupExport();
  } catch (e) {
    console.error("init failed", e);
  }
}

async function loadStats() {
  const data = await api(`/api-stats?period=${window.app.state.period}`);
  document.querySelector("#kpi-total .kpi-value").textContent = `${data.total.toFixed(2)} zł`;
  document.querySelector("#kpi-avg .kpi-value").textContent = `${data.avg_per_day.toFixed(2)} zł`;
  document.querySelector("#kpi-top .kpi-value").textContent = data.top_category;
  renderDonut(data.by_category);
  renderLine(data.by_day);
  renderTop(data.top5_categories);
  renderMembers(data.by_member);
}

async function loadTx() {
  const data = await api(`/api-transactions?limit=20&offset=${window.app.state.txOffset}`);
  window.app.state.txList.push(...data.items);
  renderTxList(window.app.state.txList);
}

function renderDonut(byCategory) {
  const el = document.getElementById("chart-donut");
  if (window.app.charts.donut) window.app.charts.donut.destroy();
  window.app.charts.donut = new Chart(el, {
    type: "doughnut",
    data: {
      labels: byCategory.map((c) => c.name),
      datasets: [{ data: byCategory.map((c) => c.amount) }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { color: getComputedStyle(document.body).color } },
      },
    },
  });
}

// renderLine, renderTop, renderMembers, renderTxList similarly...

function setupPeriodSwitch() {
  document.querySelectorAll("#period-switch button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#period-switch button").forEach((b) =>
        b.classList.remove("active")
      );
      btn.classList.add("active");
      window.app.state.period = btn.dataset.period;
      window.app.state.txOffset = 0;
      window.app.state.txList = [];
      await loadStats();
      await loadTx();
    });
  });
}

function setupSearch() {
  const input = document.getElementById("search");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const data = await api(`/api-transactions?limit=50&search=${encodeURIComponent(q)}`);
      renderTxList(data.items);
    }, 300);
  });
}

function setupExport() {
  document.getElementById("export-csv").addEventListener("click", async () => {
    const r = await fetch(`${FUNCTIONS_URL}/api-export?period=${window.app.state.period}`, {
      headers: { "Authorization": `tma ${initData}` },
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finbot-${window.app.state.period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
```

## When you finish

Return: files modified, widgets added, any TODO left, browser test result.
