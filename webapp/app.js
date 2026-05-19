// FinBot Mini App view-model.
// No localStorage/sessionStorage (SPEC §0 ban). State lives in JS objects only.

const SUPABASE_URL = "https://bltbuptzsswaislqagwe.supabase.co";
const API_BASE = SUPABASE_URL + "/functions/v1";
const TX_PAGE = 50;

const state = {
  period: "month",
  txOffset: 0,
  txSearch: "",
  txItems: [],
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
    const cat = state.categories.get(t.category_id);
    const fm = state.family.get(t.family_member_id);
    li.innerHTML = '<div class="name">' + escapeHtml(t.name) +
      '<div class="meta">' + t.expense_date + " | " + (cat ? cat.name : "?") +
      (fm ? " | " + escapeHtml(fm.name) : "") + "</div></div>" +
      '<div class="amt">' + Number(t.amount).toFixed(2) + " " + t.currency + "</div>";
    ul.appendChild(li);
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
