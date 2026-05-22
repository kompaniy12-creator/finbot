// FinBot Mini App view-model.
// No localStorage/sessionStorage (SPEC §0 ban). State lives in JS objects only.

const SUPABASE_URL = "https://bltbuptzsswaislqagwe.supabase.co";
const API_BASE = SUPABASE_URL + "/functions/v1";
const TX_PAGE = 50;

const state = {
  period: "month",
  from: null, // YYYY-MM-DD when period === "custom"
  to: null,
  txOffset: 0,
  txSearch: "",
  txItems: [], // mixed feed: kind=receipt|expense
  expandedReceipts: new Map(), // receipt_id -> [line items], lazy-loaded
  categories: new Map(),
  family: new Map(),
  byCategory: [], // breakdown from api-stats: all 24 cats with totals incl. zeros
  charts: { donut: null, line: null, bar: null },
};

function periodQuery() {
  if (state.period === "custom" && state.from && state.to) {
    return `from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  }
  return "period=" + encodeURIComponent(state.period);
}

const $ = (sel) => document.querySelector(sel);

function gateOrApp() {
  if (!window.TG || !TG.isReady) {
    $("#gate").classList.remove("hidden");
    $("#app").classList.add("hidden");
    return false;
  }
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  return true;
}

async function api(path, opts = {}) {
  const url = API_BASE + path;
  const headers = Object.assign({}, opts.headers, {
    "Authorization": "tma " + TG.initData,
    "X-Telegram-Init-Data": TG.initData,
  });
  const resp = await fetch(url, Object.assign({}, opts, { headers }));
  if (resp.status === 401) {
    TG.showAlert("Срок сессии истек. Открой Mini App заново через бота.");
    throw new Error("401");
  }
  return resp;
}

async function loadCategoriesAndFamily() {
  const [c, f] = await Promise.all([
    api("/api-categories").then((r) => r.json()),
    api("/api-family").then((r) => r.json()),
  ]);
  for (const cat of c.items || []) state.categories.set(cat.id, cat);
  for (const fm of f.items || []) state.family.set(fm.id, fm);
}

async function loadKpis() {
  const r = await api("/api-stats?" + periodQuery()).then((r) => r.json());
  $("#kpi-total").textContent = (r.total_eur || 0).toFixed(2) + " EUR";
  $("#kpi-count").textContent = r.count || 0;
  if (r.top_category_id) {
    const c = state.categories.get(r.top_category_id);
    $("#kpi-top").textContent = (c ? c.name : "?") + " (" + (r.top_category_total || 0).toFixed(0) +
      " EUR)";
  } else {
    $("#kpi-top").textContent = "-";
  }
  state.byCategory = Array.isArray(r.by_category) ? r.by_category : [];
  renderCategories();
}

function renderCategories() {
  const ul = $("#cat-list");
  if (!ul) return;
  ul.innerHTML = "";
  for (const c of state.byCategory) {
    const li = document.createElement("li");
    li.className = "cat-row" + (c.total_eur > 0 ? "" : " cat-empty");
    const meta = c.count > 0 ? `${c.count} ${c.count === 1 ? "запись" : "записей"}` : "пусто";
    li.innerHTML = `<div class="name">${escapeHtml(c.name)}<div class="meta">${meta}</div></div>` +
      `<div class="amt">${Number(c.total_eur).toFixed(2)} EUR</div>`;
    ul.appendChild(li);
  }
}

async function loadTransactions(reset = false) {
  if (reset) {
    state.txOffset = 0;
    state.txItems = [];
  }
  const qs = new URLSearchParams({
    limit: String(TX_PAGE),
    offset: String(state.txOffset),
    search: state.txSearch,
  });
  const r = await api("/api-transactions?" + qs.toString() + "&" + periodQuery())
    .then((r) => r.json());
  state.txItems = state.txItems.concat(r.items || []);
  renderTransactions();
}

function categoryMetaHtml(catId) {
  const c = state.categories.get(catId);
  const name = c ? c.name : "?";
  return `<span class="cat-link" data-cat-id="${catId || ""}">${escapeHtml(name)}</span>`;
}

function renderTransactions() {
  const ul = $("#tx-list");
  ul.innerHTML = "";
  for (const t of state.txItems) {
    const li = document.createElement("li");
    li.className = "tx-row " + (t.kind === "receipt" ? "tx-receipt" : "tx-expense");
    const fm = state.family.get(t.family_member_id);
    if (t.kind === "receipt") {
      const expanded = state.expandedReceipts.has(t.id);
      const caret = expanded ? "▾" : "▸";
      const meta = `${t.expense_date} | чек, ${t.item_count} поз.` +
        (fm ? ` | ${escapeHtml(fm.name)}` : "");
      li.innerHTML =
        `<div class="name"><span class="caret">${caret}</span> ${
          escapeHtml(t.title)
        }<div class="meta">${meta}</div></div>` +
        `<div class="amt">${Number(t.amount).toFixed(2)} ${t.currency}</div>` +
        `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
      li.style.cursor = "pointer";
      li.addEventListener("click", (ev) => {
        if (ev.target && ev.target.classList.contains("tx-del")) return;
        toggleReceipt(t.id);
      });
      const delBtn = li.querySelector(".tx-del");
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteItem("receipt", t.id, `чек "${t.title}"`);
      });
      ul.appendChild(li);
      if (expanded) {
        const items = state.expandedReceipts.get(t.id) || [];
        const warn = state.receiptWarnings && state.receiptWarnings.get(t.id);
        if (warn) {
          const wli = document.createElement("li");
          wli.className = "tx-sub tx-warn";
          wli.innerHTML =
            `<div class="name">⚠ Сохранено ${warn.saved} из ${warn.ocr} распознанных позиций. ` +
            `Удали чек и пришли фото заново, либо проверь руками.</div>`;
          ul.appendChild(wli);
        }
        for (const ln of items) {
          const sub = document.createElement("li");
          sub.className = "tx-sub";
          sub.innerHTML =
            `<div class="name">${escapeHtml(ln.name)}<div class="meta">${
              categoryMetaHtml(ln.category_id)
            }${ln.needs_review ? " · нужна проверка" : ""}</div></div>` +
            `<div class="amt">${Number(ln.amount).toFixed(2)} ${ln.currency}</div>` +
            `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
          sub.querySelector(".tx-del").addEventListener("click", (ev) => {
            ev.stopPropagation();
            deleteItem("expense", ln.id, `позицию "${ln.name}"`, t.id);
          });
          const link = sub.querySelector(".cat-link");
          if (link) {
            link.addEventListener("click", (ev) => {
              ev.stopPropagation();
              openCategoryPicker(ln, t.id);
            });
          }
          ul.appendChild(sub);
        }
      }
    } else {
      const metaPrefix = `${t.expense_date} | `;
      const metaSuffix = fm ? ` | ${escapeHtml(fm.name)}` : "";
      li.innerHTML =
        `<div class="name">${escapeHtml(t.title)}<div class="meta">${metaPrefix}${
          categoryMetaHtml(t.category_id)
        }${metaSuffix}</div></div>` +
        `<div class="amt">${Number(t.amount).toFixed(2)} ${t.currency}</div>` +
        `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
      li.querySelector(".tx-del").addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteItem("expense", t.id, `запись "${t.title}"`);
      });
      const link = li.querySelector(".cat-link");
      if (link) {
        link.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openCategoryPicker(t, null);
        });
      }
      ul.appendChild(li);
    }
  }
}

function openCategoryPicker(expense, receiptId) {
  const modal = $("#cat-modal");
  const list = $("#cat-modal-list");
  $("#cat-modal-title").textContent = `Категория для: ${expense.name || expense.title || "запись"}`;
  list.innerHTML = "";
  const sorted = [...state.categories.values()].sort((a, b) => {
    if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
    return a.name.localeCompare(b.name, "ru");
  });
  for (const c of sorted) {
    const li = document.createElement("li");
    if (c.id === expense.category_id) li.className = "active";
    li.textContent = c.name;
    li.addEventListener("click", () => recategorize(expense, c, receiptId));
    list.appendChild(li);
  }
  modal.classList.remove("hidden");
}

function closeCategoryPicker() {
  $("#cat-modal").classList.add("hidden");
}

async function recategorize(expense, category, receiptId) {
  if (expense.category_id === category.id) {
    closeCategoryPicker();
    return;
  }
  try {
    const r = await api("/api-recategorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expense_id: expense.id, category_id: category.id }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      TG.showAlert("Не удалось изменить категорию: " + (err.error || r.status));
      return;
    }
    expense.category_id = category.id;
    if (receiptId) {
      const items = state.expandedReceipts.get(receiptId) || [];
      const idx = items.findIndex((x) => x.id === expense.id);
      if (idx >= 0) items[idx] = { ...items[idx], category_id: category.id };
      state.expandedReceipts.set(receiptId, items);
    } else {
      const idx = state.txItems.findIndex(
        (x) => x.kind === "expense" && x.id === expense.id,
      );
      if (idx >= 0) state.txItems[idx] = { ...state.txItems[idx], category_id: category.id };
    }
    closeCategoryPicker();
    renderTransactions();
    loadKpis().catch(() => {});
    loadCharts();
  } catch (_e) {
    TG.showAlert("Ошибка сети при смене категории.");
  }
}

async function deleteItem(kind, id, label, receiptId) {
  const ok = await TG.showConfirm(`Удалить ${label}?`);
  if (!ok) return;
  try {
    const r = await api("/api-delete-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, id }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      TG.showAlert("Не удалось удалить: " + (err.error || r.status));
      return;
    }
    if (kind === "receipt") {
      state.txItems = state.txItems.filter((x) => !(x.kind === "receipt" && x.id === id));
      state.expandedReceipts.delete(id);
    } else if (receiptId) {
      const items = (state.expandedReceipts.get(receiptId) || []).filter((x) => x.id !== id);
      state.expandedReceipts.set(receiptId, items);
      const parent = state.txItems.find((x) => x.kind === "receipt" && x.id === receiptId);
      if (parent) parent.item_count = Math.max(0, parent.item_count - 1);
    } else {
      state.txItems = state.txItems.filter((x) => !(x.kind === "expense" && x.id === id));
    }
    renderTransactions();
    loadKpis().catch(() => {});
    loadCharts();
  } catch (e) {
    TG.showAlert("Ошибка сети при удалении.");
  }
}

async function toggleReceipt(id) {
  if (state.expandedReceipts.has(id)) {
    state.expandedReceipts.delete(id);
    renderTransactions();
    return;
  }
  try {
    const r = await api("/api-receipt-items?id=" + encodeURIComponent(id)).then((r) => r.json());
    state.expandedReceipts.set(id, r.items || []);
    if (r.receipt && r.receipt.verified === false) {
      state.receiptWarnings = state.receiptWarnings || new Map();
      state.receiptWarnings.set(id, {
        ocr: r.receipt.ocr_item_count,
        saved: r.receipt.saved_item_count,
      });
    }
    renderTransactions();
  } catch (e) {
    TG.showAlert("Не удалось загрузить позиции чека.");
  }
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

const CHART_PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#f97316",
  "#a855f7",
  "#06b6d4",
  "#ef4444",
  "#eab308",
  "#14b8a6",
  "#ec4899",
  "#64748b",
];

const emptyChartPlugin = {
  id: "emptyChart",
  afterDraw(chart, _args, options) {
    if (!options?.enabled) return;
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    ctx.save();
    ctx.fillStyle = cssVar("--hint", "#999999");
    ctx.font = "500 13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Пока нет данных",
      (chartArea.left + chartArea.right) / 2,
      (chartArea.top + chartArea.bottom) / 2,
    );
    ctx.restore();
  },
};

Chart.register(emptyChartPlugin);

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function money(v) {
  return Number(v || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " EUR";
}

function chartTextColor() {
  return cssVar("--text", "#111827");
}

function chartHintColor(alpha = 1) {
  const hint = cssVar("--hint", "#8a8a8a");
  if (hint.startsWith("#")) return hint;
  return alpha === 1 ? hint : `rgba(128, 128, 128, ${alpha})`;
}

function commonChartOptions(empty) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 850,
      easing: "easeOutQuart",
      delay(ctx) {
        return ctx.type === "data" ? ctx.dataIndex * 34 : 0;
      },
    },
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      emptyChart: { enabled: empty },
      tooltip: {
        backgroundColor: cssVar("--bg", "#ffffff"),
        titleColor: chartTextColor(),
        bodyColor: chartTextColor(),
        borderColor: cssVar("--line", "rgba(120,120,120,.22)"),
        borderWidth: 1,
        cornerRadius: 12,
        padding: 10,
        displayColors: true,
        boxPadding: 4,
        callbacks: {
          label(ctx) {
            const label = ctx.dataset.label ? ctx.dataset.label + ": " : "";
            return label + money(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed);
          },
        },
      },
    },
  };
}

function lineGradient(ctx) {
  const { chart, chartArea } = ctx;
  if (!chartArea) return "rgba(59,130,246,0.16)";
  const gradient = chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, "rgba(59,130,246,0.34)");
  gradient.addColorStop(0.62, "rgba(34,197,94,0.12)");
  gradient.addColorStop(1, "rgba(59,130,246,0)");
  return gradient;
}

async function loadCharts() {
  // Donut by category: aggregate from /api-transactions (we already have first page).
  // All chart values are in EUR (per-row, converted at expense_date rate).
  const byCat = new Map();
  for (const t of state.txItems) {
    const c = state.categories.get(t.category_id);
    const key = c ? c.name : "?";
    byCat.set(key, (byCat.get(key) || 0) + Number(t.amount_eur || 0));
  }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  drawDonut(top);
  drawLineByDay();
  drawBarTop5(top);
}

function drawDonut(entries) {
  destroy("donut");
  const data = entries.filter((e) => Number(e[1]) > 0);
  const empty = data.length === 0;
  state.charts.donut = new Chart(document.getElementById("donut"), {
    type: "doughnut",
    data: {
      labels: empty ? ["Нет данных"] : data.map((e) => e[0]),
      datasets: [{
        data: empty ? [1] : data.map((e) => Number(e[1].toFixed(2))),
        backgroundColor: empty
          ? ["rgba(120,120,120,.16)"]
          : data.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]),
        borderColor: cssVar("--card-bg", "#ffffff"),
        borderWidth: 3,
        borderRadius: 8,
        hoverOffset: 14,
        spacing: 3,
      }],
    },
    options: {
      ...commonChartOptions(empty),
      cutout: "68%",
      plugins: {
        ...commonChartOptions(empty).plugins,
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 9,
            boxHeight: 9,
            usePointStyle: true,
            color: chartTextColor(),
            padding: 12,
            font: { size: 11, weight: "500" },
          },
        },
        tooltip: {
          ...commonChartOptions(empty).plugins.tooltip,
          callbacks: {
            label(ctx) {
              if (empty) return "Нет расходов";
              const total = data.reduce((sum, e) => sum + Number(e[1]), 0);
              const value = Number(ctx.parsed || 0);
              const pct = total > 0 ? Math.round((value / total) * 100) : 0;
              return `${ctx.label}: ${money(value)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function drawBarTop5(entries) {
  destroy("bar");
  const top5 = entries.filter((e) => Number(e[1]) > 0).slice(0, 5);
  const empty = top5.length === 0;
  state.charts.bar = new Chart(document.getElementById("bar"), {
    type: "bar",
    data: {
      labels: empty ? ["Нет данных"] : top5.map((e) => e[0]),
      datasets: [{
        label: "Расходы",
        data: empty ? [0] : top5.map((e) => Number(e[1].toFixed(2))),
        backgroundColor(ctx) {
          return CHART_PALETTE[ctx.dataIndex % CHART_PALETTE.length];
        },
        borderRadius: 10,
        borderSkipped: false,
        barThickness: 16,
      }],
    },
    options: {
      ...commonChartOptions(empty),
      indexAxis: "y",
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: "rgba(128,128,128,.12)", drawBorder: false },
          ticks: { color: chartHintColor(), callback: (v) => `${v}€` },
        },
        y: {
          grid: { display: false, drawBorder: false },
          ticks: { color: chartTextColor(), font: { size: 12, weight: "500" } },
        },
      },
      plugins: {
        ...commonChartOptions(empty).plugins,
        legend: { display: false },
      },
    },
  });
}

function drawLineByDay() {
  destroy("line");
  const byDay = new Map();
  for (const t of state.txItems) {
    byDay.set(t.expense_date, (byDay.get(t.expense_date) || 0) + Number(t.amount_eur || 0));
  }
  const days = [...byDay.keys()].sort();
  const values = days.map((d) => Number(byDay.get(d).toFixed(2)));
  const empty = days.length === 0;
  state.charts.line = new Chart(document.getElementById("line"), {
    type: "line",
    data: {
      labels: empty ? [""] : days.map((d) => d.slice(5)),
      datasets: [{
        label: "Расходы",
        data: empty ? [0] : values,
        fill: true,
        backgroundColor: lineGradient,
        borderColor: "#3b82f6",
        borderWidth: 3,
        tension: 0.42,
        pointRadius: empty ? 0 : 3.5,
        pointHoverRadius: 6,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: "#3b82f6",
        pointBorderWidth: 2,
      }],
    },
    options: {
      ...commonChartOptions(empty),
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: chartHintColor(), maxRotation: 0, autoSkipPadding: 18 },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(128,128,128,.12)", drawBorder: false },
          ticks: { color: chartHintColor(), callback: (v) => `${v}€` },
        },
      },
      plugins: {
        ...commonChartOptions(empty).plugins,
        legend: { display: false },
      },
    },
  });
}

function destroy(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    state.charts[key] = null;
  }
}

async function refresh() {
  await loadKpis();
  await loadTransactions(true);
  await loadCharts();
}

async function main() {
  if (!gateOrApp()) return;
  if (TG.themeAttach) TG.themeAttach();

  if (TG.user && TG.user.first_name) $("#hello").textContent = "FinBot, " + TG.user.first_name;

  await loadCategoriesAndFamily();
  await refresh();

  // Category-picker modal close handlers
  $("#cat-modal-close").addEventListener("click", closeCategoryPicker);
  document.querySelector("#cat-modal .modal-backdrop")
    .addEventListener("click", closeCategoryPicker);

  // Period tabs
  const customBox = $("#custom-range");
  const fromInput = $("#range-from");
  const toInput = $("#range-to");
  // Default the date inputs to current month so the user only has to tap.
  const todayIso = new Date().toISOString().slice(0, 10);
  toInput.value = todayIso;
  fromInput.value = todayIso.slice(0, 7) + "-01";

  document.querySelectorAll(".period-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".period-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const p = btn.dataset.period;
      if (p === "custom") {
        customBox.classList.remove("hidden");
        // Don't refresh until user hits OK.
        return;
      }
      customBox.classList.add("hidden");
      state.period = p;
      state.from = null;
      state.to = null;
      refresh();
    });
  });

  $("#range-apply").addEventListener("click", () => {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) {
      TG.showAlert("Укажи обе даты.");
      return;
    }
    if (from > to) {
      TG.showAlert("Начальная дата позже конечной.");
      return;
    }
    state.period = "custom";
    state.from = from;
    state.to = to;
    refresh();
  });

  // Search (debounced)
  let searchTimer = null;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.txSearch = e.target.value.trim();
      loadTransactions(true);
    }, 300);
  });

  // Load more
  $("#load-more").addEventListener("click", () => {
    state.txOffset += TX_PAGE;
    loadTransactions(false);
  });

  // CSV export: opens api-export with auth header isn't possible via window.open,
  // so we fetch as blob and download.
  $("#export").addEventListener("click", async () => {
    try {
      const r = await api("/api-export?period=month");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "finbot-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      TG.showAlert("Не удалось скачать CSV.");
    }
  });
}

main().catch((e) => {
  console.error(e);
  if (window.TG && TG.showAlert) TG.showAlert("Ошибка: " + e.message);
});
