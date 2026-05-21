// FinBot Mini App view-model.
// No localStorage/sessionStorage (SPEC §0 ban). State lives in JS objects only.

const SUPABASE_URL = "https://bltbuptzsswaislqagwe.supabase.co";
const API_BASE = SUPABASE_URL + "/functions/v1";
const TX_PAGE = 50;

const state = {
  period: "month",
  txOffset: 0,
  txSearch: "",
  txItems: [], // mixed feed: kind=receipt|expense
  expandedReceipts: new Map(), // receipt_id -> [line items], lazy-loaded
  categories: new Map(),
  family: new Map(),
  charts: { donut: null, line: null, bar: null },
};

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
  const r = await api("/api-stats?period=" + state.period).then((r) => r.json());
  $("#kpi-total").textContent = (r.total_pln || 0).toFixed(2) + " PLN";
  $("#kpi-count").textContent = r.count || 0;
  if (r.top_category_id) {
    const c = state.categories.get(r.top_category_id);
    $("#kpi-top").textContent = (c ? c.name : "?") + " (" + (r.top_category_total || 0).toFixed(0) +
      ")";
  } else {
    $("#kpi-top").textContent = "-";
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
  const r = await api("/api-transactions?" + qs.toString()).then((r) => r.json());
  state.txItems = state.txItems.concat(r.items || []);
  renderTransactions();
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
        for (const ln of items) {
          const sub = document.createElement("li");
          sub.className = "tx-sub";
          const cat = state.categories.get(ln.category_id);
          sub.innerHTML =
            `<div class="name">${escapeHtml(ln.name)}<div class="meta">${cat ? cat.name : "?"}${
              ln.needs_review ? " · нужна проверка" : ""
            }</div></div>` +
            `<div class="amt">${Number(ln.amount).toFixed(2)} ${ln.currency}</div>` +
            `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
          sub.querySelector(".tx-del").addEventListener("click", (ev) => {
            ev.stopPropagation();
            deleteItem("expense", ln.id, `позицию "${ln.name}"`, t.id);
          });
          ul.appendChild(sub);
        }
      }
    } else {
      const cat = state.categories.get(t.category_id);
      const meta = `${t.expense_date} | ${cat ? cat.name : "?"}` +
        (fm ? ` | ${escapeHtml(fm.name)}` : "");
      li.innerHTML =
        `<div class="name">${escapeHtml(t.title)}<div class="meta">${meta}</div></div>` +
        `<div class="amt">${Number(t.amount).toFixed(2)} ${t.currency}</div>` +
        `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
      li.querySelector(".tx-del").addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteItem("expense", t.id, `запись "${t.title}"`);
      });
      ul.appendChild(li);
    }
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

async function loadCharts() {
  // Donut by category: aggregate from /api-transactions (we already have first page).
  const byCat = new Map();
  for (const t of state.txItems) {
    const c = state.categories.get(t.category_id);
    const key = c ? c.name : "?";
    byCat.set(key, (byCat.get(key) || 0) + Number(t.amount_pln || 0));
  }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  drawDonut(top);
  drawLineByDay();
  drawBarTop5(top);
}

function drawDonut(entries) {
  destroy("donut");
  state.charts.donut = new Chart(document.getElementById("donut"), {
    type: "doughnut",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1].toFixed(2)) }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } } },
  });
}

function drawBarTop5(entries) {
  destroy("bar");
  const top5 = entries.slice(0, 5);
  state.charts.bar = new Chart(document.getElementById("bar"), {
    type: "bar",
    data: {
      labels: top5.map((e) => e[0]),
      datasets: [{ label: "PLN", data: top5.map((e) => Number(e[1].toFixed(2))) }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } } },
  });
}

function drawLineByDay() {
  destroy("line");
  const byDay = new Map();
  for (const t of state.txItems) {
    byDay.set(t.expense_date, (byDay.get(t.expense_date) || 0) + Number(t.amount_pln || 0));
  }
  const days = [...byDay.keys()].sort();
  state.charts.line = new Chart(document.getElementById("line"), {
    type: "line",
    data: {
      labels: days,
      datasets: [{ label: "PLN", data: days.map((d) => Number(byDay.get(d).toFixed(2))) }],
    },
    options: { plugins: { legend: { display: false } } },
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

  // Period tabs
  document.querySelectorAll(".period-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".period-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.period = btn.dataset.period;
      refresh();
    });
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
