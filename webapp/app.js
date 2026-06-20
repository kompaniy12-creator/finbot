// FinBot Mini App view-model.
// No localStorage/sessionStorage (SPEC §0 ban). State lives in JS objects only.

const SUPABASE_URL = "https://bltbuptzsswaislqagwe.supabase.co";
const API_BASE = SUPABASE_URL + "/functions/v1";
const TX_PAGE = 50;

// Single source of truth for the running build. Bumped on every release via
// scripts/bump_version.sh (which also rewrites the ?v= cache-bust and CHANGELOG).
// version.json on the server carries the latest published version; when it is
// newer than what this loaded build reports, we hard-reload so every user picks
// up changes automatically without reinstalling anything.
const APP_VERSION = "1.9.0";

// Poll the published version and reload once if the server moved ahead. Telegram
// keeps the webview alive in the background and may serve a cached index.html, so
// a plain ?v= bump is not always enough - this guarantees propagation to all
// users. Guarded so we reload at most once per foreground.
let updateReloadDone = false;
async function checkForUpdate() {
  if (updateReloadDone) return;
  try {
    const r = await fetch("./version.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const published = (await r.json())?.version;
    if (published && published !== APP_VERSION) {
      updateReloadDone = true;
      // Cache-bust the document itself so we don't get the stale cached shell.
      const u = new URL(location.href);
      u.searchParams.set("v", published);
      location.replace(u.toString());
    }
  } catch (_e) {
    // Offline or version.json missing: keep running the current build.
  }
}

function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const state = {
  period: "month",
  from: null, // YYYY-MM-DD when period === "custom"
  to: null,
  month: todayMonth(), // YYYY-MM, used when period === "month"
  txOffset: 0,
  txSearch: "",
  txFilterCategory: "",
  txFilterMember: "",
  txFilterSource: "",
  // "Только сверённые" toggle in the transactions filter bar.
  filterReconciled: false,
  txItems: [], // mixed feed: kind=receipt|expense
  expandedReceipts: new Map(), // receipt_id -> [line items], lazy-loaded
  categories: new Map(),
  family: new Map(),
  me: null, // { id, role, name, ... } from /api-me
  byCategory: [], // breakdown from api-stats: all 24 cats with totals incl. zeros
  byDay: [], // full-period daily totals from api-stats
  periodStart: null,
  periodEnd: null,
  charts: { donut: null, line: null, bar: null },
};

function isAdmin() {
  return state.me && state.me.role === "admin";
}

function renderDelta(el, { pct, abs, unit, higherIsWorse }) {
  if (!el) return;
  if (pct === null || pct === undefined || !isFinite(pct)) {
    // No comparable previous period (or first record ever).
    el.textContent = abs && abs > 0 ? `+${abs.toFixed(0)} ${unit}` : "";
    el.className = "kpi-delta";
    return;
  }
  const rounded = Math.round(pct * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const tone = rounded === 0
    ? "neutral"
    : (rounded > 0 ? (higherIsWorse ? "bad" : "good") : (higherIsWorse ? "good" : "bad"));
  el.textContent = `${sign}${rounded.toFixed(1)}% vs прошлый период`;
  el.className = `kpi-delta tone-${tone}`;
}

function periodQuery() {
  if (state.period === "custom" && state.from && state.to) {
    return `from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  }
  if (state.period === "month" && state.month) {
    return "month=" + encodeURIComponent(state.month);
  }
  return "period=" + encodeURIComponent(state.period);
}

const $ = (sel) => document.querySelector(sel);

// --- Browser session (magic link flow) ---
// SPEC §0 originally banned localStorage; the magic-link desktop path needs
// somewhere durable to keep the session token across navigations, and an
// httpOnly cookie would require server-side Set-Cookie wiring that we don't
// yet have. localStorage is acceptable here because (a) the token is opaque
// and short-lived (24h), (b) /web_logout invalidates it server-side, and
// (c) it's only set on desktop browsers, never inside the Telegram WebView.
const WEB_SESSION_KEY = "finbot_web_session";

function getWebSession() {
  try {
    const raw = localStorage.getItem(WEB_SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.token || !obj.expires_at) return null;
    if (new Date(obj.expires_at) <= new Date()) {
      localStorage.removeItem(WEB_SESSION_KEY);
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function setWebSession(token, expires_at) {
  try {
    localStorage.setItem(WEB_SESSION_KEY, JSON.stringify({ token, expires_at }));
  } catch (_) { /* private mode */ }
}

function clearWebSession() {
  try {
    localStorage.removeItem(WEB_SESSION_KEY);
  } catch (_) { /* private mode */ }
}

// Exchange ?magic=<token> in the URL for a durable session. Runs once at
// page load. Always clears the URL afterwards so the magic doesn't leak
// into bookmarks or share-with-friends.
async function bootstrapMagic() {
  const params = new URLSearchParams(location.search);
  const magic = params.get("magic");
  if (!magic) return;
  try {
    const r = await fetch(API_BASE + "/api-web-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magic }),
    });
    if (r.ok) {
      const j = await r.json();
      if (j && j.session && j.expires_at) {
        setWebSession(j.session, j.expires_at);
      }
    }
  } catch (_) { /* network failure - user will see gate */ }
  // Strip ?magic= from the URL whether the exchange worked or not.
  params.delete("magic");
  const cleanQuery = params.toString();
  const cleanUrl = location.pathname + (cleanQuery ? "?" + cleanQuery : "");
  history.replaceState({}, "", cleanUrl);
}

function gateOrApp() {
  const tgReady = window.TG && TG.isReady;
  const webSession = getWebSession();
  const nav = $("#bottom-nav");
  if (!tgReady && !webSession) {
    $("#gate").classList.remove("hidden");
    $("#app").classList.add("hidden");
    if (nav) nav.classList.add("hidden");
    return false;
  }
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (nav) nav.classList.remove("hidden");
  return true;
}

// --- Bottom-nav tabs ----------------------------------------------------
// `tab-only` sections are gated by CSS rules tied to a body class. The
// selected tab also drives a runtime filter on the transaction feed so
// "Доходы"/"Расходы" show only matching rows; "Дашборд" shows everything.
const VALID_TABS = [
  "dashboard",
  "ops",
  "planning",
  "debts",
  "credits",
  "investments",
  "settings",
];
state.tab = "dashboard";
// Within the unified "Операции" tab, which side is shown: "expense" | "income".
state.txKind = "expense";

// Set the income/expense side of the ops tab. Drives a body class (CSS reveals
// the matching KPI), the toggle button highlight, and the tx-feed filter.
function setTxKind(kind) {
  state.txKind = kind === "income" ? "income" : "expense";
  document.body.classList.toggle("txkind-income", state.txKind === "income");
  document.body.classList.toggle("txkind-expense", state.txKind === "expense");
  for (const b of document.querySelectorAll(".ops-toggle .ops-kind-btn")) {
    b.classList.toggle("active", b.dataset.txkind === state.txKind);
  }
  if (typeof renderTransactions === "function") renderTransactions();
}

function setActiveTab(tab) {
  // Map legacy income/expense deep-links onto the unified ops tab.
  if (tab === "income") {
    setTxKind("income");
    tab = "ops";
  } else if (tab === "expense") {
    setTxKind("expense");
    tab = "ops";
  }
  if (!VALID_TABS.includes(tab)) tab = "dashboard";
  state.tab = tab;
  // Body class drives CSS visibility for all `.tab-only` sections.
  for (const t of VALID_TABS) document.body.classList.remove("tab-" + t);
  document.body.classList.add("tab-" + tab);
  // Highlight the nav button.
  const buttons = document.querySelectorAll("#bottom-nav .nav-btn");
  for (const b of buttons) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  // Re-render the tx list with the kind filter applied.
  if (typeof renderTransactions === "function") renderTransactions();
  // Lazy-load credits / debts on entry to their tabs.
  if (tab === "credits" && typeof loadCredits === "function") loadCredits();
  if (tab === "debts" && typeof loadDebts === "function") loadDebts();
  // Persist in URL hash so a refresh keeps the tab.
  try {
    history.replaceState({}, "", location.pathname + location.search + "#" + tab);
  } catch (_) { /* ignore */ }
}

function bindNav() {
  for (const btn of document.querySelectorAll("#bottom-nav .nav-btn")) {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  }
  // Income/expense toggle inside the unified ops tab.
  for (const btn of document.querySelectorAll(".ops-toggle .ops-kind-btn")) {
    btn.addEventListener("click", () => setTxKind(btn.dataset.txkind));
  }
  setTxKind(state.txKind); // sync body class + button highlight
  // Telegram keeps the Mini App webview alive in the background; when it is
  // brought back to the foreground, reload the current tab so the user never
  // sees stale data (e.g. a debt that was already repaid).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForUpdate();
      refreshCurrentTab();
    }
  });
  checkForUpdate();
  const initial = (location.hash || "").replace("#", "");
  // Accept legacy #income / #expense deep-links (setActiveTab maps them to ops).
  const allowed = initial === "income" || initial === "expense" ||
    VALID_TABS.includes(initial);
  setActiveTab(allowed ? initial : "dashboard");
}

// Hook the settings "Отозвать сессии" button into api-* surface.
async function bindSettings() {
  bindThemePicker();
  bindProfileEditor();
  bindUsersPanel();
  bindUserFormModal();

  const btn = $("#settings-web-logout");
  if (btn) {
    btn.addEventListener("click", () => {
      const status = $("#settings-web-logout-status");
      status.textContent = "В Telegram: /web_logout";
      status.className = "settings-status tone-good";
    });
  }
}

// --- Theme picker -------------------------------------------------------
// Three modes: auto (use Telegram's CSS vars, no override class), light,
// dark. Persisted in localStorage so the choice survives reloads even when
// the Mini App is reopened from a fresh Telegram launch.
const THEME_KEY = "finbot_theme";
function applyTheme(theme) {
  document.body.classList.remove("theme-light", "theme-dark");
  if (theme === "light") document.body.classList.add("theme-light");
  else if (theme === "dark") document.body.classList.add("theme-dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) { /* private mode */ }
}
function loadTheme() {
  let saved = "auto";
  try {
    saved = localStorage.getItem(THEME_KEY) || "auto";
  } catch (_) { /* ignore */ }
  if (!["auto", "light", "dark"].includes(saved)) saved = "auto";
  applyTheme(saved);
  return saved;
}
function bindThemePicker() {
  const current = loadTheme();
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === current;
    r.addEventListener("change", () => applyTheme(r.value));
  }
}

// --- Profile (own display name) -----------------------------------------
function bindProfileEditor() {
  const input = $("#settings-name-input");
  const btn = $("#settings-name-save");
  if (!input || !btn) return;
  input.value = (state.me && state.me.name) || "";
  btn.addEventListener("click", async () => {
    const newName = (input.value || "").trim();
    const status = $("#settings-name-status");
    if (!newName) {
      status.textContent = "Имя не может быть пустым.";
      status.className = "settings-status tone-bad";
      return;
    }
    if (newName === state.me?.name) {
      status.textContent = "Без изменений.";
      status.className = "settings-status";
      return;
    }
    btn.disabled = true;
    status.textContent = "...";
    status.className = "settings-status";
    try {
      const r = await api("/api-me-mutate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        status.textContent = "Ошибка: " + (err.error || r.status);
        status.className = "settings-status tone-bad";
        return;
      }
      const j = await r.json();
      if (j.member) {
        state.me = { ...(state.me || {}), name: j.member.name };
        // Refresh the greeting in the header.
        if (TG.user && TG.user.first_name) {
          $("#hello").textContent = "FinBot, " + j.member.name;
        }
      }
      status.textContent = "Сохранено ✓";
      status.className = "settings-status tone-good";
    } catch (e) {
      if (!isSessionExpired(e)) {
        status.textContent = "Ошибка сети";
        status.className = "settings-status tone-bad";
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// --- Users panel (admin only) -------------------------------------------
// Hidden for non-admins. Lists every family_member (including inactive
// revoked ones, greyed out) with quick promote/demote/revoke/restore.
async function bindUsersPanel() {
  const wrapper = $("#settings-users-wrapper");
  if (!wrapper) return;
  if (!isAdmin()) {
    wrapper.style.display = "none";
    return;
  }
  wrapper.style.display = "";
  await refreshUsersList();
  const addBtn = $("#settings-user-add");
  if (addBtn) addBtn.addEventListener("click", openUserForm);
}

async function refreshUsersList() {
  const ul = $("#settings-users-list");
  if (!ul) return;
  ul.innerHTML = "<li class='cat-empty'>загрузка...</li>";
  try {
    // api-family-mutate doesn't have a list endpoint; api-family does, and
    // it returns active members. We need inactive too for the admin UI,
    // so call a direct query via the admin path - reuse api-family which
    // we'll teach in a moment. For now, just show active members from
    // state.family.
    const r = await api("/api-family?all=1").then((r) => r.json());
    const items = Array.isArray(r.items) ? r.items : [];
    if (items.length === 0) {
      ul.innerHTML = "<li class='cat-empty'>Никого нет.</li>";
      return;
    }
    ul.innerHTML = "";
    for (const u of items) {
      ul.appendChild(renderUserRow(u));
    }
  } catch (e) {
    if (!isSessionExpired(e)) {
      ul.innerHTML = "<li class='cat-empty'>Ошибка загрузки.</li>";
    }
  }
}

function renderUserRow(u) {
  const li = document.createElement("li");
  li.className = "user-row";
  const isSelf = state.me && u.id === state.me.id;
  const badge = !u.active
    ? '<span class="role-badge role-inactive">отозван</span>'
    : u.role === "admin"
    ? '<span class="role-badge role-admin">админ</span>'
    : '<span class="role-badge role-member">участник</span>';
  const selfTag = isSelf ? ' <small style="color: var(--hint);">(ты)</small>' : "";
  li.innerHTML = `<div class="user-head">
       <span class="user-name">${escapeHtml(u.name)} ${badge}${selfTag}</span>
       <span class="user-meta">tid: ${u.telegram_id}</span>
     </div>
     <div class="user-actions"></div>`;
  const actions = li.querySelector(".user-actions");
  const mkBtn = (label, opts, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (opts && opts.danger) b.classList.add("danger");
    if (opts && opts.disabled) b.disabled = true;
    if (handler) b.addEventListener("click", handler);
    return b;
  };
  // Promote / demote (disabled on self for safety - can't lose all admins).
  if (u.active) {
    if (u.role === "member") {
      actions.appendChild(
        mkBtn("Сделать админом", { disabled: isSelf }, () => patchUser(u.id, { role: "admin" })),
      );
    } else {
      actions.appendChild(
        mkBtn("Снять админа", { disabled: isSelf }, () => patchUser(u.id, { role: "member" })),
      );
    }
    actions.appendChild(
      mkBtn("Отозвать", { danger: true, disabled: isSelf }, () => revokeUser(u.id, u.name)),
    );
  } else {
    actions.appendChild(mkBtn("Восстановить", {}, () => patchUser(u.id, { active: true })));
  }
  return li;
}

async function patchUser(id, patch) {
  try {
    const r = await api("/api-family-mutate?id=" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msgs = {
        cannot_demote_self: "Нельзя снять с себя роль админа.",
        cannot_revoke_self: "Нельзя отозвать доступ у самого себя.",
      };
      TG.showAlert(msgs[err.error] || ("Ошибка: " + (err.error || r.status)));
      return;
    }
    await refreshUsersList();
    await loadCategoriesAndFamily();
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети");
  }
}

async function revokeUser(id, name) {
  const ok = await TG.showConfirm(`Отозвать доступ у "${name}"?`);
  if (!ok) return;
  try {
    const r = await api("/api-family-mutate?id=" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      TG.showAlert("Ошибка: " + (err.error || r.status));
      return;
    }
    await refreshUsersList();
    await loadCategoriesAndFamily();
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети");
  }
}

// --- User add modal -----------------------------------------------------
function bindUserFormModal() {
  const close = $("#user-form-close");
  const cancel = $("#user-form-cancel");
  const save = $("#user-form-save");
  if (!close || !cancel || !save) return;
  close.addEventListener("click", closeUserForm);
  cancel.addEventListener("click", closeUserForm);
  document.querySelector("#user-form-modal .modal-backdrop")
    .addEventListener("click", closeUserForm);
  save.addEventListener("click", submitUserForm);
}
function openUserForm() {
  $("#user-form-modal").classList.remove("hidden");
  $("#user-form-tid").value = "";
  $("#user-form-name").value = "";
  $("#user-form-role").value = "member";
  setTimeout(() => $("#user-form-tid").focus(), 50);
}
function closeUserForm() {
  $("#user-form-modal").classList.add("hidden");
}
async function submitUserForm() {
  const tid = Number($("#user-form-tid").value || "0");
  const name = ($("#user-form-name").value || "").trim();
  const role = $("#user-form-role").value;
  if (!tid || tid < 1000) {
    TG.showAlert("Введи валидный Telegram ID (число от 1000).");
    return;
  }
  if (!name) {
    TG.showAlert("Имя обязательно.");
    return;
  }
  const save = $("#user-form-save");
  save.disabled = true;
  try {
    const r = await api("/api-family-mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: tid, name, role }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msgs = { already_active: "Этот пользователь уже активен." };
      TG.showAlert(msgs[err.error] || ("Ошибка: " + (err.error || r.status)));
      return;
    }
    closeUserForm();
    await refreshUsersList();
    await loadCategoriesAndFamily();
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети");
  } finally {
    save.disabled = false;
  }
}

// Reuse a single rejection for stale-session so callers' catch blocks can
// avoid stacking a second alert on top of the one api() already shows.
const SESSION_EXPIRED = Symbol("session_expired");
let sessionAlertShown = false;

async function api(path, opts = {}) {
  const url = API_BASE + path;
  const ws = getWebSession();
  const headers = Object.assign({}, opts.headers);
  if (ws) {
    headers["Authorization"] = "Bearer " + ws.token;
  } else if (window.TG && TG.isReady) {
    headers["Authorization"] = "tma " + TG.initData;
    headers["X-Telegram-Init-Data"] = TG.initData;
  }
  const resp = await fetch(url, Object.assign({}, opts, { headers }));
  if (resp.status === 401) {
    if (!sessionAlertShown) {
      sessionAlertShown = true;
      const msg = ws
        ? "Сессия в браузере истекла. Попроси у бота новую ссылку командой /web."
        : "Срок сессии истёк. Закрой Mini App и открой заново через бота.";
      if (window.TG && TG.showAlert && TG.isReady) {
        TG.showAlert(msg);
      } else {
        alert(msg);
      }
    }
    if (ws) clearWebSession();
    throw SESSION_EXPIRED;
  }
  return resp;
}

function isSessionExpired(e) {
  return e === SESSION_EXPIRED;
}

async function loadCategoriesAndFamily() {
  const [c, f, m] = await Promise.all([
    api("/api-categories").then((r) => r.json()),
    api("/api-family").then((r) => r.json()),
    api("/api-me").then((r) => r.json()).catch(() => ({ me: null })),
  ]);
  state.categories = new Map();
  for (const cat of c.items || []) state.categories.set(cat.id, cat);
  state.family = new Map();
  for (const fm of f.items || []) state.family.set(fm.id, fm);
  state.me = m.me ?? null;
}

function fhSetTone(el, tone) {
  el.classList.remove("tone-good", "tone-warn", "tone-bad");
  if (tone) el.classList.add("tone-" + tone);
}

// "Здоровье финансов" block: savings rate (the number that matters most),
// free cash this period, and debt load. All derived from api-stats.
function renderFinanceHealth({ income, prevIncome, net, prevNet, r }) {
  const rateEl = $("#fh-savings-rate");
  const hintEl = $("#fh-savings-hint");
  const deltaEl = $("#fh-savings-delta");
  const rate = income > 0 ? (net / income) * 100 : null;
  const prevRate = prevIncome > 0 ? (prevNet / prevIncome) * 100 : null;
  if (rate == null) {
    rateEl.textContent = "-";
    fhSetTone(rateEl, null);
    hintEl.textContent = "нет дохода за период";
    deltaEl.textContent = "";
  } else {
    rateEl.textContent = Math.round(rate) + "%";
    fhSetTone(rateEl, rate >= 20 ? "good" : rate >= 5 ? "warn" : "bad");
    hintEl.textContent = rate >= 20
      ? "отлично - ты приумножаешь"
      : rate >= 5
      ? "неплохо, можно больше"
      : rate >= 0
      ? "на грани - почти всё уходит"
      : "тратишь больше, чем зарабатываешь";
    if (prevRate != null) {
      const dpp = Math.round(rate - prevRate);
      deltaEl.textContent = (dpp >= 0 ? "▲ +" : "▼ ") + dpp + " пп к прошлому";
      fhSetTone(deltaEl, dpp >= 0 ? "good" : "bad");
    } else {
      deltaEl.textContent = "";
    }
  }

  const freeEl = $("#fh-free");
  freeEl.textContent = (net >= 0 ? "+" : "") + net.toFixed(2) + " EUR";
  fhSetTone(freeEl, net > 0 ? "good" : net < 0 ? "bad" : null);

  const debtEl = $("#fh-debt-load");
  const debtHint = $("#fh-debt-hint");
  const debtMonthly = Number(r.debt_monthly_eur ?? 0);
  const load = income > 0 ? (debtMonthly / income) * 100 : null;
  if (debtMonthly <= 0) {
    debtEl.textContent = "0%";
    fhSetTone(debtEl, "good");
    debtHint.textContent = "нет активных кредитов";
  } else if (load == null) {
    debtEl.textContent = "-";
    fhSetTone(debtEl, null);
    debtHint.textContent = debtMonthly.toFixed(0) + " EUR/мес - нет дохода для оценки";
  } else {
    debtEl.textContent = Math.round(load) + "%";
    fhSetTone(debtEl, load < 15 ? "good" : load <= 35 ? "warn" : "bad");
    debtHint.textContent = debtMonthly.toFixed(0) + " EUR/мес по кредитам";
  }
}

async function loadKpis() {
  const r = await api("/api-stats?" + periodQuery()).then((r) => r.json());
  $("#kpi-total").textContent = (r.total_eur || 0).toFixed(2) + " EUR";
  $("#kpi-count").textContent = r.count || 0;
  renderDelta($("#kpi-total-delta"), {
    pct: r.delta_eur_pct,
    abs: r.delta_eur,
    unit: "EUR",
    higherIsWorse: true,
  });
  renderDelta($("#kpi-count-delta"), {
    pct: r.prev_count > 0 ? ((r.count - r.prev_count) / r.prev_count) * 100 : null,
    abs: r.delta_count,
    unit: "",
    higherIsWorse: false,
  });

  // Income + Net KPIs (added when income tracking shipped). Older
  // api-stats versions don't return r.income; fall back to zero so the
  // tiles render "0.00 EUR" instead of "undefined".
  const incomeTotal = Number(r.income?.total_eur ?? 0);
  const incomePrev = Number(r.income?.prev_total_eur ?? 0);
  $("#kpi-income").textContent = incomeTotal.toFixed(2) + " EUR";
  renderDelta($("#kpi-income-delta"), {
    pct: incomePrev > 0 ? ((incomeTotal - incomePrev) / incomePrev) * 100 : null,
    abs: incomeTotal - incomePrev,
    unit: "EUR",
    higherIsWorse: false, // more income = good
  });
  const net = Number(r.net_eur ?? (incomeTotal - (r.total_eur ?? 0)));
  const prevNet = Number(r.prev_net_eur ?? 0);
  const netEl = $("#kpi-net");
  netEl.textContent = (net >= 0 ? "+" : "") + net.toFixed(2) + " EUR";
  netEl.className = net >= 0 ? "tone-good" : "tone-bad";
  renderDelta($("#kpi-net-delta"), {
    pct: prevNet !== 0 ? ((net - prevNet) / Math.abs(prevNet)) * 100 : null,
    abs: net - prevNet,
    unit: "EUR",
    higherIsWorse: false,
  });

  renderFinanceHealth({ income: incomeTotal, prevIncome: incomePrev, net, prevNet, r });
  // Month-end forecast (only meaningful for month-to-date view).
  const fcEl = $("#kpi-forecast");
  if (fcEl) {
    if (r.forecast_total_eur != null && r.forecast_days_remaining > 0) {
      fcEl.textContent = `Прогноз на конец месяца: ~${
        Number(r.forecast_total_eur).toFixed(0)
      } EUR (осталось ${r.forecast_days_remaining} д.)`;
    } else {
      fcEl.textContent = "";
    }
  }
  if (r.top_category_id) {
    const c = state.categories.get(r.top_category_id);
    $("#kpi-top").textContent = (c ? c.name : "?") + " (" + (r.top_category_total || 0).toFixed(0) +
      " EUR)";
  } else {
    $("#kpi-top").textContent = "-";
  }
  // Per-source-currency breakdown under "Всего".
  const byCurUl = $("#kpi-by-currency");
  if (byCurUl) {
    byCurUl.innerHTML = "";
    const list = Array.isArray(r.by_currency) ? r.by_currency : [];
    for (const c of list) {
      if (!c || Number(c.total) <= 0) continue;
      const li = document.createElement("li");
      li.innerHTML = `<span class="ccy">${escapeHtml(c.currency)}</span>` +
        `<span class="amt">${Number(c.total).toFixed(2)}</span>`;
      byCurUl.appendChild(li);
    }
  }
  state.byCategory = Array.isArray(r.by_category) ? r.by_category : [];
  state.byDay = Array.isArray(r.by_day) ? r.by_day : [];
  state.periodStart = r.period_start || null;
  state.periodEnd = r.period_end || null;
  renderCategories();
  renderHeatmap();
}

function renderCategories() {
  // Dashboard category list: read-only summary of WHERE the money went this
  // period. Only rows with actual spend; zero-spend categories live in the
  // settings panel, not the dashboard. No edit/delete here - those are in
  // Настройки → Расходы / Доходы.
  const ul = $("#cat-list");
  if (!ul) return;
  ul.innerHTML = "";
  const rows = state.byCategory.filter((c) => Number(c.total_eur) > 0);
  if (rows.length === 0) {
    ul.innerHTML = `<li class="cat-empty">За этот период расходов ещё не было.</li>`;
    return;
  }
  for (const c of rows) {
    const li = document.createElement("li");
    li.className = "cat-row";
    const meta = c.count > 0 ? `${c.count} ${c.count === 1 ? "запись" : "записей"}` : "пусто";
    li.innerHTML = `<div class="name">${escapeHtml(c.name)}<div class="meta">${meta}</div></div>` +
      `<div class="amt">${Number(c.total_eur).toFixed(2)} EUR</div>`;
    ul.appendChild(li);
  }
  // Render the settings panel CRUD lists alongside, so opening Настройки
  // shows the full per-kind picture without an extra round-trip.
  renderSettingsCategoryList("expense", "#settings-cat-expense");
  renderSettingsCategoryList("income", "#settings-cat-income");
}

function renderSettingsCategoryList(kind, ulSelector) {
  const ul = document.querySelector(ulSelector);
  if (!ul) return;
  ul.innerHTML = "";
  const admin = isAdmin();
  // Settings list is the FULL catalogue for that kind, including empties.
  // categories Map is keyed by id and carries kind from api-categories.
  const all = [...state.categories.values()]
    .filter((c) => (c.kind ?? "expense") === kind)
    .sort((a, b) => {
      if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
      return (a.name || "").localeCompare(b.name || "", "ru");
    });
  if (all.length === 0) {
    ul.innerHTML = `<li class="cat-empty">Категорий нет. Нажми «+ Категория».</li>`;
    return;
  }
  for (const c of all) {
    const li = document.createElement("li");
    li.className = "cat-row";
    const fallbackTag = c.is_fallback
      ? `<small style="color: var(--hint);"> (fallback)</small>`
      : "";
    const meta = c.usage_count ? `использована ${c.usage_count} раз` : "ещё не использована";
    const adminBtns = admin
      ? `<button class="cat-edit" type="button" data-id="${c.id}" title="Изменить">✏️</button>` +
        (c.is_fallback
          ? `<button class="cat-del" type="button" disabled title="Fallback нельзя удалить">×</button>`
          : `<button class="cat-del" type="button" data-id="${c.id}" data-name="${
            escapeHtml(c.name)
          }" data-count="${c.usage_count || 0}" title="Удалить">×</button>`)
      : "";
    li.innerHTML =
      `<div class="name">${escapeHtml(c.name)}${fallbackTag}<div class="meta">${meta}</div></div>` +
      adminBtns;
    ul.appendChild(li);
  }
  if (admin) {
    ul.querySelectorAll(".cat-edit").forEach((b) => {
      b.addEventListener("click", () => openCategoryForm(b.dataset.id, kind));
    });
    ul.querySelectorAll(".cat-del[data-id]").forEach((b) => {
      b.addEventListener(
        "click",
        () => deleteCategory(b.dataset.id, b.dataset.name, Number(b.dataset.count || "0")),
      );
    });
  }
  // Hide the per-kind + button for non-admins.
  const addBtn = document.querySelector(
    kind === "income" ? "#settings-add-income" : "#settings-add-expense",
  );
  if (addBtn) addBtn.style.display = admin ? "" : "none";
}

function renderHeatmap() {
  const el = $("#heatmap");
  if (!el || !state.periodStart || !state.periodEnd) return;
  const byDay = new Map((state.byDay || []).map((d) => [d.date, Number(d.total_eur || 0)]));
  const start = state.periodStart;
  const end = state.periodEnd;
  const startMs = new Date(start + "T00:00:00Z").getTime();
  const endMs = new Date(end + "T00:00:00Z").getTime();
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (days <= 0 || days > 366) {
    el.innerHTML = `<div class="heatmap-empty">период не выбран</div>`;
    return;
  }
  const max = Math.max(0, ...byDay.values());
  el.innerHTML = "";
  // Align so columns are weekdays Mon-Sun. getUTCDay: 0=Sunday..6=Saturday;
  // convert to Mon=0..Sun=6.
  const firstDow = (new Date(startMs).getUTCDay() + 6) % 7;
  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement("div");
    blank.className = "hm-cell hm-blank";
    el.appendChild(blank);
  }
  for (let i = 0; i < days; i++) {
    const t = startMs + i * 86_400_000;
    const iso = new Date(t).toISOString().slice(0, 10);
    const v = byDay.get(iso) ?? 0;
    const intensity = max > 0 ? Math.min(1, v / max) : 0;
    const lvl = v === 0 ? 0 : intensity < 0.25 ? 1 : intensity < 0.5 ? 2 : intensity < 0.75 ? 3 : 4;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `hm-cell hm-lvl-${lvl}`;
    const dayNum = Number(iso.slice(8, 10));
    cell.innerHTML = `<span class="hm-day">${dayNum}</span>` +
      (v > 0 ? `<span class="hm-amt">${Math.round(v)}€</span>` : "");
    cell.title = v > 0 ? `${iso}: ${v.toFixed(2)} EUR` : `${iso}: без трат`;
    cell.dataset.date = iso;
    cell.addEventListener("click", () => {
      // Tap a day: jump period to that single day.
      state.period = "custom";
      state.from = iso;
      state.to = iso;
      document.querySelectorAll(".period-tabs button").forEach((b) => b.classList.remove("active"));
      const dayBtn = document.querySelector(".period-tabs button[data-period='custom']");
      if (dayBtn) dayBtn.classList.add("active");
      refresh();
    });
    el.appendChild(cell);
  }
}

async function openReceiptPhoto(receiptId, title) {
  const m = $("#photo-modal");
  const img = $("#photo-modal-img");
  $("#photo-modal-title").textContent = title || "Фото чека";
  img.removeAttribute("src");
  m.classList.remove("hidden");
  try {
    const r = await api("/api-receipt-photo?id=" + encodeURIComponent(receiptId));
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = {
        no_photo: "У этого чека нет сохранённого фото.",
        photo_purged: "Фото удалено (срок хранения истёк).",
      }[err.error] || ("Не удалось загрузить фото: " + (err.error || r.status));
      TG.showAlert(msg);
      m.classList.add("hidden");
      return;
    }
    const j = await r.json();
    if (!j.url) {
      TG.showAlert("Пустой URL фото.");
      m.classList.add("hidden");
      return;
    }
    img.src = j.url;
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети при загрузке фото.");
    m.classList.add("hidden");
  }
}

function closePhotoModal() {
  $("#photo-modal").classList.add("hidden");
  $("#photo-modal-img").removeAttribute("src");
}

// When creating a new category, `kind` ('expense' | 'income') tells the
// backend which bucket it belongs to. When editing, kind is derived from
// the existing row and isn't editable.
function openCategoryForm(catId, kind) {
  const m = $("#cat-form-modal");
  const cat = catId ? state.byCategory.find((c) => c.id === catId) : null;
  const raw = catId ? state.categories.get(catId) : null;
  const resolvedKind = (raw && raw.kind) || kind || "expense";
  state.catFormKind = resolvedKind;
  const kindLabel = resolvedKind === "income" ? "дохода" : "расхода";
  $("#cat-form-title").textContent = catId
    ? `Изменить категорию ${kindLabel}`
    : `Новая категория ${kindLabel}`;
  $("#cat-form-id").value = catId || "";
  $("#cat-form-name").value = (raw && raw.name) || (cat && cat.name) || "";
  $("#cat-form-desc").value = (raw && raw.description) || "";
  $("#cat-form-fallback").checked = Boolean(raw && raw.is_fallback);
  $("#cat-form-save").disabled = false;
  m.classList.remove("hidden");
  setTimeout(() => $("#cat-form-name").focus(), 50);
}

function closeCategoryForm() {
  $("#cat-form-modal").classList.add("hidden");
}

async function submitCategoryForm() {
  const id = $("#cat-form-id").value || null;
  const name = $("#cat-form-name").value.trim();
  const description = $("#cat-form-desc").value.trim();
  const isFallback = $("#cat-form-fallback").checked;
  if (!name) {
    TG.showAlert("Имя категории обязательно.");
    return;
  }
  if (!description) {
    TG.showAlert("Описание категории обязательно (используется для авто-классификации).");
    return;
  }
  $("#cat-form-save").disabled = true;
  try {
    const path = id ? "/api-category-mutate?id=" + encodeURIComponent(id) : "/api-category-mutate";
    // kind is only meaningful on create (POST); the backend rejects it on
    // PATCH because changing kind would orphan child expense rows.
    const body = id
      ? { name, description, is_fallback: isFallback }
      : { name, description, is_fallback: isFallback, kind: state.catFormKind || "expense" };
    const r = await api(path, {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = {
        name_taken: "Категория с таким именем уже есть.",
        need_a_fallback: "Должна остаться хотя бы одна fallback-категория.",
        forbidden: "Только админ может менять категории.",
      }[err.error] || ("Ошибка: " + (err.error || r.status));
      TG.showAlert(msg);
      return;
    }
    closeCategoryForm();
    await loadCategoriesAndFamily();
    await refresh();
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети.");
  } finally {
    $("#cat-form-save").disabled = false;
  }
}

async function deleteCategory(id, name, count) {
  const note = count > 0
    ? `В категории "${name}" уже ${count} ${
      count === 1 ? "запись" : "записей"
    }. Они будут перенесены в «Дополнительные расходы». Удалить?`
    : `Удалить категорию "${name}"?`;
  const ok = await TG.showConfirm(note);
  if (!ok) return;
  try {
    const r = await api("/api-category-mutate?id=" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = {
        cannot_delete_fallback: "Fallback-категорию нельзя удалить.",
        forbidden: "Только админ может удалять категории.",
      }[err.error] || ("Ошибка: " + (err.error || r.status));
      TG.showAlert(msg);
      return;
    }
    await loadCategoriesAndFamily();
    await refresh();
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети.");
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
  if (state.txFilterCategory) qs.set("category_id", state.txFilterCategory);
  if (state.txFilterMember) qs.set("family_member_id", state.txFilterMember);
  if (state.txFilterSource) qs.set("source", state.txFilterSource);
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
  // Feed filter. On the unified "Операции" tab the income/expense toggle
  // (state.txKind) restricts the feed; "dashboard" shows everything mixed.
  // Receipts have tx_kind='expense' by definition (you don't photograph a
  // paycheck).
  const tabFilter = state.tab === "ops"
    ? (state.txKind === "income" ? (t) => t.tx_kind === "income" : (t) => t.tx_kind !== "income")
    : () => true;
  // "Только сверённые" toggle (state.filterReconciled). When true, only
  // rows the bot matched against a PDF bank statement are shown.
  const baseItems = state.filterReconciled
    ? state.txItems.filter((t) => t.reconciled)
    : state.txItems;
  for (const t of baseItems.filter(tabFilter)) {
    const li = document.createElement("li");
    const isIncome = t.tx_kind === "income";
    // Payment-method glyph next to the amount: 💳 card / 💵 cash / 🏦
    // bank transfer / nothing for unknown. ✓ chip after the amount when
    // the row has been reconciled against a PDF bank statement.
    const pm = t.payment_method || "unknown";
    const pmIcon = pm === "card" ? "💳" : pm === "cash" ? "💵" : pm === "transfer" ? "🏦" : "";
    const recIcon = t.reconciled ? " <span class='tx-rec' title='Сверено с банком'>✓</span>" : "";
    // Human-readable reconciliation date for the meta line.
    const recDate = t.reconciled && t.reconciled_at
      ? ` · сверено ${formatRecDate(t.reconciled_at)}`
      : t.reconciled
      ? " · сверено"
      : "";
    li.className = "tx-row " + (t.kind === "receipt" ? "tx-receipt" : "tx-expense") +
      (isIncome ? " tx-income" : "") +
      (t.reconciled ? " tx-reconciled" : "");
    const fm = state.family.get(t.family_member_id);
    if (t.kind === "receipt") {
      const expanded = state.expandedReceipts.has(t.id);
      const caret = expanded ? "▾" : "▸";
      const meta = `${t.expense_date} | чек, ${t.item_count} поз.` +
        (fm ? ` | ${escapeHtml(fm.name)}` : "") + recDate;
      const sign = isIncome ? "+" : "";
      li.innerHTML =
        `<div class="name"><span class="caret">${caret}</span> ${
          escapeHtml(t.title)
        } <button class="tx-photo" type="button" data-id="${t.id}" data-title="${
          escapeHtml(t.title)
        }" title="Открыть фото чека">🖼</button><div class="meta">${meta}</div></div>` +
        `<div class="amt">${pmIcon ? pmIcon + " " : ""}${sign}${
          Number(t.amount).toFixed(2)
        } ${t.currency}${recIcon}</div>` +
        `<button class="tx-del" type="button" title="Удалить" aria-label="Удалить">×</button>`;
      li.style.cursor = "pointer";
      li.addEventListener("click", (ev) => {
        const cl = ev.target && ev.target.classList;
        if (!cl) return toggleReceipt(t.id);
        if (cl.contains("tx-del") || cl.contains("tx-photo")) return;
        toggleReceipt(t.id);
      });
      const photoBtn = li.querySelector(".tx-photo");
      if (photoBtn) {
        photoBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openReceiptPhoto(t.id, t.title);
        });
      }
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
      // isIncome / pmIcon / recIcon already computed up top.
      const metaPrefix = `${t.expense_date} | `;
      const metaSuffix = (fm ? ` | ${escapeHtml(fm.name)}` : "") + recDate;
      const sign = isIncome ? "+" : "";
      li.innerHTML =
        `<div class="name">${escapeHtml(t.title)}<div class="meta">${metaPrefix}${
          categoryMetaHtml(t.category_id)
        }${metaSuffix}</div></div>` +
        `<div class="amt">${pmIcon ? pmIcon + " " : ""}${sign}${
          Number(t.amount).toFixed(2)
        } ${t.currency}${recIcon}</div>` +
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
  // Determine the row's kind so we only show same-kind categories - an
  // income row (salary) should never be re-classified into "Алкоголь", and
  // vice versa. Sources:
  //   - api-transactions FeedItem: tx_kind
  //   - api-receipt-items line:    kind
  //   - last-resort fallback:      kind of the row's current category
  let rowKind = expense.tx_kind || expense.kind;
  if (!rowKind && expense.category_id) {
    const cur = state.categories.get(expense.category_id);
    rowKind = (cur && cur.kind) || "expense";
  }
  if (!rowKind) rowKind = "expense";
  const kindLabel = rowKind === "income" ? "дохода" : "расхода";
  $("#cat-modal-title").textContent = `Категория ${kindLabel} для: ${
    expense.name || expense.title || "запись"
  }`;
  list.innerHTML = "";
  const sorted = [...state.categories.values()]
    .filter((c) => (c.kind || "expense") === rowKind)
    .sort((a, b) => {
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
  } catch (e) {
    if (!isSessionExpired(e)) TG.showAlert("Ошибка сети при смене категории.");
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
    if (isSessionExpired(e)) return; // alert already shown by api()
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
    if (!isSessionExpired(e)) TG.showAlert("Не удалось загрузить позиции чека.");
  }
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// Short "сверено 03.06" style date label for the meta line. Strips the
// year + time so the meta stays compact.
function formatRecDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
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

const doughnutCenterPlugin = {
  id: "doughnutCenter",
  afterDraw(chart, _args, options) {
    if (!options?.enabled) return;
    const meta = chart.getDatasetMeta(0);
    const arc = meta?.data?.[0];
    if (!arc) return;
    const { ctx } = chart;
    const total = options.total || 0;
    const label = options.label || "всего";
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = chartTextColor();
    ctx.font = "700 24px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.fillText(money(total).replace(" EUR", "€"), arc.x, arc.y - 8);
    ctx.fillStyle = cssVar("--hint", "#999999");
    ctx.font = "600 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.fillText(label, arc.x, arc.y + 16);
    ctx.restore();
  },
};

Chart.register(emptyChartPlugin, doughnutCenterPlugin);

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
            // Horizontal bar (indexAxis="y") puts the value on .x and the
            // row index on .y - reading .y first would show "0.00 EUR" for
            // the top row, "1.00 EUR" for the next, etc. Pick the axis that
            // actually carries the magnitude based on the chart's indexAxis.
            const isHorizontalBar = ctx.chart?.options?.indexAxis === "y";
            let val;
            if (typeof ctx.parsed === "number") val = ctx.parsed;
            else if (isHorizontalBar) val = ctx.parsed.x ?? ctx.parsed.y ?? 0;
            else val = ctx.parsed.y ?? ctx.parsed.x ?? 0;
            return label + money(val);
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
  // Full-period category totals come from /api-stats, not the paginated
  // transaction feed, so large receipts and unloaded pages are still counted.
  const top = state.byCategory
    .filter((c) => Number(c.total_eur) > 0)
    .map((c) => [c.name, Number(c.total_eur)])
    .sort((a, b) => b[1] - a[1]);
  drawDonut(top);
  drawLineByDay();
  drawBarTop5(top);
}

function drawDonut(entries) {
  destroy("donut");
  const data = entries.filter((e) => Number(e[1]) > 0);
  const empty = data.length === 0;
  const total = data.reduce((sum, e) => sum + Number(e[1]), 0);
  state.charts.donut = new Chart(document.getElementById("donut"), {
    type: "doughnut",
    data: {
      labels: empty ? ["Нет данных"] : data.map((e) => e[0]),
      datasets: [{
        data: empty ? [1] : data.map((e) => Number(e[1].toFixed(2))),
        backgroundColor: empty
          ? ["rgba(120,120,120,.16)"]
          : data.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]),
        borderColor: "rgba(255,255,255,.34)",
        borderWidth: 1,
        borderRadius: 0,
        hoverOffset: 8,
        spacing: 0,
      }],
    },
    options: {
      ...commonChartOptions(empty),
      cutout: "68%",
      plugins: {
        ...commonChartOptions(empty).plugins,
        doughnutCenter: { enabled: !empty, total, label: "по всем категориям" },
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
        tooltip: {
          ...commonChartOptions(empty).plugins.tooltip,
          // Horizontal bar: bar magnitude lives on .x. We override the
          // common callback explicitly to avoid any indexAxis-detection
          // edge cases in Chart.js.
          callbacks: {
            label(ctx) {
              if (empty) return "Нет расходов";
              const value = Number(ctx.parsed?.x ?? 0);
              return `${ctx.dataset.label}: ${money(value)}`;
            },
          },
        },
      },
    },
  });
}

function drawLineByDay() {
  destroy("line");
  const days = state.byDay.map((d) => d.date);
  const values = state.byDay.map((d) => Number(Number(d.total_eur || 0).toFixed(2)));
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

// Reload whatever the current tab shows. Used when Telegram resumes a
// backgrounded webview (which keeps stale JS state) so the user never acts on
// out-of-date data - the root cause of the "debt already closed" confusion.
async function refreshCurrentTab() {
  try {
    if (state.tab === "debts") {
      if (typeof loadDebts === "function") await loadDebts();
    } else if (state.tab === "credits") {
      if (typeof loadCredits === "function") await loadCredits();
    } else if (state.tab === "planning") {
      if (typeof loadPlanned === "function") await loadPlanned();
    } else {
      await refresh();
    }
  } catch (_) { /* best-effort */ }
}

// --- Planned payments ("📅 План" tab) ---------------------------------
// CRUD against api-planned-payments. The form mirrors the layout from
// the reference app but drops the fields we don't have (account, payee
// book, tags) per user spec.

const planning = {
  items: [],
  filter: "all", // all | income | expense
  editingId: null,
  kind: "expense",
  subview: "hub", // hub | planned | budgets
};

function setPlanningSubview(sub) {
  planning.subview = sub;
  const panel = document.querySelector(".planning-panel");
  if (panel) panel.dataset.sub = sub;
  if (sub === "planned") loadPlannedPayments();
  if (sub === "budgets") loadBudgets();
  if (sub === "calendar") loadPaymentCalendar();
}

function formatPlanAmount(item) {
  const sign = item.kind === "income" ? "+" : "-";
  const amt = Number(item.amount).toFixed(2).replace(/\.00$/, "");
  return `${sign}${amt} ${item.currency}`;
}

function formatPlanDate(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  const months = [
    "янв",
    "фев",
    "мар",
    "апр",
    "май",
    "июн",
    "июл",
    "авг",
    "сен",
    "окт",
    "ноя",
    "дек",
  ];
  return `${day} ${months[m - 1]} ${y}`;
}

function frequencyLabel(f) {
  return {
    once: "Единовременный",
    weekly: "Еженедельно",
    monthly: "Ежемесячно",
    yearly: "Ежегодно",
  }[f] || f;
}

function methodLabel(m) {
  return { cash: "Наличные", card: "Карта", transfer: "Перевод" }[m] || m;
}

async function loadPlannedPayments() {
  try {
    const r = await api("/api-planned-payments").then((x) => x.json());
    planning.items = r.items || [];
  } catch (e) {
    if (isSessionExpired(e)) return;
    planning.items = [];
  }
  renderPlannedPayments();
}

function renderPlannedPayments() {
  const list = $("#plan-list");
  if (!list) return;
  list.innerHTML = "";

  const filtered = planning.items.filter((it) => {
    if (planning.filter === "all") return true;
    return it.kind === planning.filter;
  });

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "plan-empty";
    li.textContent = "Запланированных платежей пока нет.";
    list.appendChild(li);
    return;
  }

  for (const it of filtered) {
    const li = document.createElement("li");
    li.className = "plan-row " + (it.kind === "income" ? "plan-income" : "plan-expense");
    li.dataset.id = it.id;

    const cat = state.categories.get(it.category_id);
    const catName = cat ? cat.name : (it.kind === "income" ? "Доход" : "Расход");

    const left = document.createElement("div");
    left.className = "plan-row-left";
    const title = document.createElement("div");
    title.className = "plan-row-title";
    title.textContent = it.name;
    const meta = document.createElement("div");
    meta.className = "plan-row-meta";
    meta.textContent = `${formatPlanDate(it.next_due_date)} · ${frequencyLabel(it.frequency)} · ${
      methodLabel(it.payment_method)
    }`;
    const sub = document.createElement("div");
    sub.className = "plan-row-sub";
    sub.textContent = catName + (it.note ? ` · ${it.note}` : "");
    left.appendChild(title);
    left.appendChild(meta);
    left.appendChild(sub);

    const right = document.createElement("div");
    right.className = "plan-row-right";
    const amt = document.createElement("div");
    amt.className = "plan-row-amount";
    amt.textContent = formatPlanAmount(it);
    right.appendChild(amt);
    if (it.auto_confirm) {
      const badge = document.createElement("div");
      badge.className = "plan-row-badge";
      badge.textContent = "авто";
      right.appendChild(badge);
    }

    li.appendChild(left);
    li.appendChild(right);

    li.addEventListener("click", () => openPlanForm(it));
    list.appendChild(li);
  }
}

function fillPlanCategoryOptions(kind) {
  const sel = $("#plan-form-category");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = "";
  const cats = [...state.categories.values()]
    .filter((c) => (c.kind || "expense") === kind)
    .sort((a, b) => {
      if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
      return a.name.localeCompare(b.name, "ru");
    });
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name + (c.is_fallback ? " (fallback)" : "");
    sel.appendChild(o);
  }
  // Try to keep the previous selection if it still matches kind.
  if (cur && cats.some((c) => c.id === cur)) sel.value = cur;
}

function setPlanFormKind(kind) {
  planning.kind = kind;
  for (const b of document.querySelectorAll(".plan-kind-btn")) {
    b.classList.toggle("active", b.dataset.kind === kind);
  }
  fillPlanCategoryOptions(kind);
}

function openPlanForm(item) {
  const modal = $("#plan-form-modal");
  if (!modal) return;
  planning.editingId = item ? item.id : null;
  $("#plan-form-title").textContent = item ? "Редактировать платёж" : "Новый платёж";

  setPlanFormKind(item ? item.kind : "expense");

  $("#plan-form-amount").value = item ? item.amount : "";
  $("#plan-form-currency").value = item ? item.currency : "PLN";
  $("#plan-form-name").value = item ? item.name : "";
  if (item && item.category_id) $("#plan-form-category").value = item.category_id;
  $("#plan-form-confirm").value = item && item.auto_confirm ? "auto" : "manual";
  $("#plan-form-date").value = item ? item.next_due_date : new Date().toISOString().slice(0, 10);
  $("#plan-form-frequency").value = item ? item.frequency : "once";
  $("#plan-form-method").value = item ? item.payment_method : "cash";
  $("#plan-form-note").value = item && item.note ? item.note : "";
  $("#plan-form-notify-on-day").checked = item ? !!item.notify_on_day : true;
  $("#plan-form-notify-3d").checked = item ? !!item.notify_3d_before : true;

  $("#plan-form-delete").classList.toggle("hidden", !item);

  modal.classList.remove("hidden");
}

function closePlanForm() {
  const modal = $("#plan-form-modal");
  if (modal) modal.classList.add("hidden");
  planning.editingId = null;
}

async function savePlanForm() {
  const amount = parseFloat($("#plan-form-amount").value);
  const name = $("#plan-form-name").value.trim();
  if (!name || !(amount > 0)) {
    alert("Укажи название и сумму > 0.");
    return;
  }
  const payload = {
    kind: planning.kind,
    name,
    amount,
    currency: $("#plan-form-currency").value,
    category_id: $("#plan-form-category").value || null,
    payment_method: $("#plan-form-method").value,
    frequency: $("#plan-form-frequency").value,
    next_due_date: $("#plan-form-date").value,
    auto_confirm: $("#plan-form-confirm").value === "auto",
    notify_on_day: $("#plan-form-notify-on-day").checked,
    notify_3d_before: $("#plan-form-notify-3d").checked,
    note: $("#plan-form-note").value.trim() || null,
  };
  try {
    let resp;
    if (planning.editingId) {
      resp = await api("/api-planned-payments?id=" + planning.editingId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await api("/api-planned-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closePlanForm();
    await loadPlannedPayments();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

async function deletePlanForm() {
  if (!planning.editingId) return;
  if (!confirm("Удалить этот платёж?")) return;
  try {
    const resp = await api("/api-planned-payments?id=" + planning.editingId, {
      method: "DELETE",
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closePlanForm();
    await loadPlannedPayments();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

function bindPlanning() {
  // Hub navigation
  for (const card of document.querySelectorAll(".planning-hub-card")) {
    card.addEventListener("click", () => setPlanningSubview(card.dataset.go));
  }
  for (const back of document.querySelectorAll(".planning-sub-head [data-back]")) {
    back.addEventListener("click", () => setPlanningSubview("hub"));
  }
  // Start on hub
  setPlanningSubview("hub");

  // FAB: action depends on subview
  const addBtn = $("#plan-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (planning.subview === "planned") openPlanForm(null);
      else if (planning.subview === "budgets") openBudgetForm(null);
    });
  }

  // Planned-payments filters
  for (const f of document.querySelectorAll(".plan-filter")) {
    f.addEventListener("click", () => {
      planning.filter = f.dataset.filter;
      for (const b of document.querySelectorAll(".plan-filter")) {
        b.classList.toggle("active", b === f);
      }
      renderPlannedPayments();
    });
  }

  // Planned-payments form
  const closeBtn = $("#plan-form-close");
  if (closeBtn) closeBtn.addEventListener("click", closePlanForm);
  const backdrop = document.querySelector("#plan-form-modal .modal-backdrop");
  if (backdrop) backdrop.addEventListener("click", closePlanForm);
  const cancel = $("#plan-form-cancel");
  if (cancel) cancel.addEventListener("click", closePlanForm);
  const save = $("#plan-form-save");
  if (save) save.addEventListener("click", savePlanForm);
  const del = $("#plan-form-delete");
  if (del) del.addEventListener("click", deletePlanForm);
  for (const b of document.querySelectorAll(".plan-kind-btn")) {
    b.addEventListener("click", () => setPlanFormKind(b.dataset.kind));
  }

  // Budget form
  const bClose = $("#budget-form-close");
  if (bClose) bClose.addEventListener("click", closeBudgetForm);
  const bBackdrop = document.querySelector("#budget-form-modal .modal-backdrop");
  if (bBackdrop) bBackdrop.addEventListener("click", closeBudgetForm);
  const bCancel = $("#budget-form-cancel");
  if (bCancel) bCancel.addEventListener("click", closeBudgetForm);
  const bSave = $("#budget-form-save");
  if (bSave) bSave.addEventListener("click", saveBudgetForm);
  const bDel = $("#budget-form-delete");
  if (bDel) bDel.addEventListener("click", deleteBudgetForm);
}

// --- Budgets ("Бюджеты" sub-view of Planning) -------------------------
const budgetsState = {
  items: [],
  editingId: null,
  selectedCats: new Set(),
};

async function loadBudgets() {
  try {
    const r = await api("/api-budgets").then((x) => x.json());
    budgetsState.items = r.items || [];
  } catch (e) {
    if (isSessionExpired(e)) return;
    budgetsState.items = [];
  }
  renderBudgets();
}

function periodShortLabel(p) {
  return { weekly: "ЕЖЕНЕДЕЛЬНО", monthly: "ЕЖЕМЕСЯЧНО", yearly: "ЕЖЕГОДНО" }[p] || p;
}

function renderBudgets() {
  const list = $("#budgets-list");
  if (!list) return;
  list.innerHTML = "";
  if (budgetsState.items.length === 0) {
    const li = document.createElement("li");
    li.className = "budgets-empty";
    li.textContent = "Бюджетов пока нет.";
    list.appendChild(li);
    return;
  }
  for (const b of budgetsState.items) {
    const li = document.createElement("li");
    li.className = "budget-row";
    li.dataset.id = b.id;

    const head = document.createElement("div");
    head.className = "budget-row-head";
    const name = document.createElement("div");
    name.className = "budget-row-name";
    name.textContent = b.name;
    const period = document.createElement("div");
    period.className = "budget-row-period";
    period.textContent = periodShortLabel(b.period);
    head.appendChild(name);
    head.appendChild(period);

    const meta = document.createElement("div");
    meta.className = "budget-row-meta";
    const amt = document.createElement("div");
    amt.className = "budget-row-amount";
    amt.textContent = `${formatNumber(b.spent_amount)} / ${formatNumber(b.amount)} ${b.currency}`;
    const pct = document.createElement("div");
    pct.className = "budget-row-pct";
    pct.textContent = `${b.spent_pct}%`;
    meta.appendChild(amt);
    meta.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "budget-progress";
    const fill = document.createElement("div");
    fill.className = "budget-progress-fill";
    if (b.spent_pct >= 100) fill.classList.add("over");
    else if (b.spent_pct >= 75) fill.classList.add("warn");
    fill.style.width = Math.min(100, b.spent_pct) + "%";
    bar.appendChild(fill);

    li.appendChild(head);
    li.appendChild(meta);
    li.appendChild(bar);

    li.addEventListener("click", () => openBudgetForm(b));
    list.appendChild(li);
  }
}

function formatNumber(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace(/\.00$/, "").replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1 ");
}

function refreshBudgetCatCount() {
  const el = $("#budget-form-cat-count");
  if (!el) return;
  const n = budgetsState.selectedCats.size;
  el.textContent = String(n);
  el.classList.toggle("empty", n === 0);
}

function fillBudgetCategoryChips() {
  const box = $("#budget-form-categories");
  if (!box) return;
  box.innerHTML = "";
  const cats = [...state.categories.values()]
    .filter((c) => (c.kind || "expense") === "expense")
    .sort((a, b) => {
      if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
      return a.name.localeCompare(b.name, "ru");
    });
  for (const c of cats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "budget-cat-chip";
    btn.dataset.id = c.id;
    btn.textContent = c.name;
    if (budgetsState.selectedCats.has(c.id)) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (budgetsState.selectedCats.has(c.id)) {
        budgetsState.selectedCats.delete(c.id);
        btn.classList.remove("active");
      } else {
        budgetsState.selectedCats.add(c.id);
        btn.classList.add("active");
      }
      refreshBudgetCatCount();
    });
    box.appendChild(btn);
  }
  refreshBudgetCatCount();
}

function openBudgetForm(item) {
  const modal = $("#budget-form-modal");
  if (!modal) return;
  budgetsState.editingId = item ? item.id : null;
  budgetsState.selectedCats = new Set(item?.category_ids || []);

  $("#budget-form-title").textContent = item ? "Редактировать бюджет" : "Добавить бюджет";
  $("#budget-form-amount").value = item ? item.amount : "";
  $("#budget-form-currency").value = item ? item.currency : "EUR";
  $("#budget-form-name").value = item ? item.name : "";
  $("#budget-form-period").value = item ? item.period : "monthly";
  $("#budget-form-notify-exceed").checked = item ? !!item.notify_on_exceed : true;
  $("#budget-form-notify-75").checked = item ? !!item.notify_at_75 : true;

  fillBudgetCategoryChips();
  const det = $("#budget-form-cat-details");
  if (det) det.open = false;
  $("#budget-form-delete").classList.toggle("hidden", !item);
  modal.classList.remove("hidden");
}

function closeBudgetForm() {
  const modal = $("#budget-form-modal");
  if (modal) modal.classList.add("hidden");
  budgetsState.editingId = null;
  budgetsState.selectedCats = new Set();
}

async function saveBudgetForm() {
  const amount = parseFloat($("#budget-form-amount").value);
  const name = $("#budget-form-name").value.trim();
  if (!name || !(amount > 0)) {
    alert("Укажи название и сумму > 0.");
    return;
  }
  if (budgetsState.selectedCats.size === 0) {
    alert("Выбери хотя бы одну категорию.");
    return;
  }
  const payload = {
    name,
    amount,
    currency: $("#budget-form-currency").value,
    period: $("#budget-form-period").value,
    category_ids: [...budgetsState.selectedCats],
    notify_on_exceed: $("#budget-form-notify-exceed").checked,
    notify_at_75: $("#budget-form-notify-75").checked,
  };
  try {
    let resp;
    if (budgetsState.editingId) {
      resp = await api("/api-budgets?id=" + budgetsState.editingId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await api("/api-budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeBudgetForm();
    await loadBudgets();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

async function deleteBudgetForm() {
  if (!budgetsState.editingId) return;
  if (!confirm("Удалить этот бюджет?")) return;
  try {
    const resp = await api("/api-budgets?id=" + budgetsState.editingId, {
      method: "DELETE",
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeBudgetForm();
    await loadBudgets();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

// --- Payment calendar ("📅 Платёжный календарь" sub-view) ------------
// Merges planned_payments, credits (projected monthly), and debts (with
// due_date) into a single month grid. Tapping a day shows that day's
// events in a list below the grid.

const paymentCalendar = {
  monthStart: null, // ISO "YYYY-MM-01" of the visible month
  items: [], // raw events from api
  byDay: new Map(), // 'YYYY-MM-DD' -> [event...]
  selectedDate: null,
};

function isoDate(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString().slice(0, 10);
}

function monthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  const months = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  return `${months[m - 1]} ${y}`;
}

function shiftMonth(iso, delta) {
  const [y, m] = iso.split("-").map(Number);
  let ny = y, nm = m + delta;
  while (nm < 1) {
    nm += 12;
    ny--;
  }
  while (nm > 12) {
    nm -= 12;
    ny++;
  }
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

function monthEnd(iso) {
  const [y, m] = iso.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
}

async function loadPaymentCalendar() {
  if (!paymentCalendar.monthStart) {
    const today = new Date();
    paymentCalendar.monthStart = `${today.getFullYear()}-${
      String(today.getMonth() + 1).padStart(2, "0")
    }-01`;
    paymentCalendar.selectedDate = isoDate(today);
  }
  const from = paymentCalendar.monthStart;
  const to = monthEnd(from);
  try {
    const r = await api(`/api-payment-calendar?from=${from}&to=${to}`).then((x) => x.json());
    paymentCalendar.items = r.items || [];
  } catch (e) {
    if (isSessionExpired(e)) return;
    paymentCalendar.items = [];
  }
  paymentCalendar.byDay = new Map();
  for (const ev of paymentCalendar.items) {
    const arr = paymentCalendar.byDay.get(ev.date) ?? [];
    arr.push(ev);
    paymentCalendar.byDay.set(ev.date, arr);
  }
  renderPaymentCalendar();
}

function renderPaymentCalendar() {
  $("#cal-month-label").textContent = monthLabel(paymentCalendar.monthStart);
  const grid = $("#cal-grid");
  grid.innerHTML = "";

  const [y, m] = paymentCalendar.monthStart.split("-").map(Number);
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Mon=0
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayIso = isoDate(new Date());

  // Lead-in days from prev month (greyed)
  const prev = shiftMonth(paymentCalendar.monthStart, -1);
  const [py, pm] = prev.split("-").map(Number);
  const prevDim = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  for (let i = 0; i < firstDow; i++) {
    const day = prevDim - firstDow + 1 + i;
    const cell = document.createElement("div");
    cell.className = "cal-cell out";
    cell.textContent = day;
    grid.appendChild(cell);
  }

  // Current month days
  for (let d = 1; d <= dim; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (iso === todayIso) cell.classList.add("today");
    if (iso === paymentCalendar.selectedDate) cell.classList.add("selected");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = d;
    cell.appendChild(num);

    const dots = document.createElement("div");
    dots.className = "cal-dots";
    const events = paymentCalendar.byDay.get(iso) ?? [];
    const sourcesSeen = new Set();
    for (const ev of events) {
      const key = ev.source + ":" + (ev.kind || "");
      if (sourcesSeen.has(key)) continue;
      sourcesSeen.add(key);
      const dot = document.createElement("span");
      dot.className = "cal-dot src-" + ev.source +
        (ev.source === "planned" && ev.kind === "income" ? " kind-income" : "");
      dots.appendChild(dot);
    }
    cell.appendChild(dots);
    cell.addEventListener("click", () => {
      paymentCalendar.selectedDate = iso;
      renderPaymentCalendar();
    });
    grid.appendChild(cell);
  }

  // Tail-out from next month so grid keeps 6 rows when applicable
  const total = firstDow + dim;
  const tail = total <= 35 ? 35 - total : 42 - total;
  for (let i = 1; i <= tail; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-cell out";
    cell.textContent = i;
    grid.appendChild(cell);
  }

  renderCalendarDayList();
}

function renderCalendarDayList() {
  const list = $("#cal-day-list");
  const title = $("#cal-day-title");
  list.innerHTML = "";
  const sel = paymentCalendar.selectedDate;
  if (!sel) {
    title.textContent = "Выберите день";
    return;
  }
  title.textContent = formatPlanDate(sel);
  const events = paymentCalendar.byDay.get(sel) ?? [];
  if (events.length === 0) {
    const li = document.createElement("li");
    li.className = "cal-day-empty";
    li.textContent = "В этот день платежей нет.";
    list.appendChild(li);
    return;
  }
  for (const ev of events) {
    const li = document.createElement("li");
    li.className = "src-" + ev.source + " " + (ev.kind || "expense");
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "ev-name";
    name.textContent = ev.name;
    const meta = document.createElement("div");
    meta.className = "ev-meta";
    const bits = [];
    if (ev.source === "credit") bits.push("кредит");
    if (ev.source === "debt") bits.push("долг");
    if (ev.source === "planned") bits.push(ev.kind === "income" ? "доход (план)" : "расход (план)");
    if (ev.category_name) bits.push(ev.category_name);
    if (ev.meta === "авто") bits.push("авто");
    meta.textContent = bits.join(" · ");
    left.appendChild(name);
    left.appendChild(meta);
    const amt = document.createElement("div");
    amt.className = "ev-amount " + (ev.kind === "income" ? "income" : "expense");
    const sign = ev.kind === "income" ? "+" : "-";
    amt.textContent = `${sign}${formatNumber(ev.amount)} ${ev.currency}`;
    li.appendChild(left);
    li.appendChild(amt);
    list.appendChild(li);
  }
}

function bindPaymentCalendar() {
  const prev = $("#cal-prev");
  const next = $("#cal-next");
  if (prev) {
    prev.addEventListener("click", () => {
      paymentCalendar.monthStart = shiftMonth(paymentCalendar.monthStart, -1);
      paymentCalendar.selectedDate = paymentCalendar.monthStart;
      loadPaymentCalendar();
    });
  }
  if (next) {
    next.addEventListener("click", () => {
      paymentCalendar.monthStart = shiftMonth(paymentCalendar.monthStart, 1);
      paymentCalendar.selectedDate = paymentCalendar.monthStart;
      loadPaymentCalendar();
    });
  }
}

// --- Credits ("🏦 Кредит" tab) ---------------------------------------
// Real CRUD against api-credits + a "Зафиксировать платёж" flow that
// creates the matching expense row and decrements the credit balance.

const CREDIT_TYPES = {
  cash_loan: "Денежный кредит",
  installment: "Рассрочка",
  credit_card: "Кредитка",
  mortgage: "Ипотека",
  auto_loan: "Автокредит",
  pos_credit: "POS-кредит",
  microloan: "Микрозайм",
  overdraft: "Овердрафт",
  other: "Прочее",
};

const credits = {
  all: [], // unfiltered from the API
  items: [], // filtered for display
  filter: "active",
  editingId: null,
  // Reset every time the form opens.
  payTarget: null,
};

function annuityPayment(principal, annualRatePct, months) {
  const p = Number(principal) || 0;
  const n = Number(months) || 0;
  if (p <= 0 || n <= 0) return null;
  const r = (Number(annualRatePct) || 0) / 100 / 12;
  if (r <= 0) return Math.round((p / n) * 100) / 100;
  const m = (p * r) / (1 - Math.pow(1 + r, -n));
  return Math.round(m * 100) / 100;
}

async function loadCredits() {
  // Always fetch all so the stats card can run on the full active set
  // regardless of which filter chip the user has selected.
  try {
    const r = await api("/api-credits?status=all").then((x) => x.json());
    credits.all = r.items || [];
  } catch (e) {
    if (isSessionExpired(e)) return;
    credits.all = [];
  }
  applyCreditsFilter();
}

function applyCreditsFilter() {
  credits.items = credits.filter === "all"
    ? credits.all
    : credits.all.filter((c) => c.status === credits.filter);
  renderCredits();
}

function renderCreditsStats() {
  const box = $("#credits-stats");
  if (!box) return;
  box.innerHTML = "";
  const active = credits.all.filter((c) => c.status === "active");
  if (active.length === 0) return;

  // Group by responsibility: credits without borrowed_for are mine;
  // anything with borrowed_for is grouped per borrower so the user can
  // see at a glance what is actually owed by other people vs themselves.
  const groups = new Map();
  for (const c of active) {
    const key = (c.borrowed_for && String(c.borrowed_for).trim().length > 0)
      ? String(c.borrowed_for).trim()
      : "__mine__";
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  // Mine first, then alphabetical by borrower.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "__mine__") return -1;
    if (b === "__mine__") return 1;
    return a.localeCompare(b, "ru");
  });

  for (const key of sortedKeys) {
    const list = groups.get(key);
    const isMine = key === "__mine__";

    const section = document.createElement("div");
    section.className = "cs-section" + (isMine ? " cs-mine" : " cs-foreign");

    const head = document.createElement("div");
    head.className = "cs-group-head";
    head.textContent = isMine ? "💼 Мои кредиты" : `🤝 Для: ${key}`;
    section.appendChild(head);

    // Per-currency aggregation within this group.
    const byCcy = new Map();
    for (const c of list) {
      const cur = byCcy.get(c.currency) ?? {
        count: 0,
        principal: 0,
        remaining: 0,
        monthly: 0,
      };
      cur.count++;
      cur.principal += Number(c.principal) || 0;
      cur.remaining += Number(c.remaining_balance) || 0;
      cur.monthly += Number(c.monthly_payment) || 0;
      byCcy.set(c.currency, cur);
    }

    for (const [ccy, s] of byCcy) {
      const paid = Math.max(0, s.principal - s.remaining);
      const pct = s.principal > 0 ? Math.round((paid / s.principal) * 100) : 0;
      const card = document.createElement("div");
      card.className = "cs-card";

      const top = document.createElement("div");
      top.className = "cs-top";
      const left = document.createElement("div");
      left.innerHTML = `<span class="cs-num">${s.count}</span> активных в ${ccy}`;
      const right = document.createElement("div");
      right.className = "cs-monthly";
      // monthly_payment may be null (variable-amount credits like
      // overdraft interest) - show '~' marker instead of '0/мес'.
      right.textContent = s.monthly > 0
        ? `${formatNumber(s.monthly)} ${ccy}/мес`
        : "переменная сумма";
      top.appendChild(left);
      top.appendChild(right);

      const remain = document.createElement("div");
      remain.className = "cs-remain";
      remain.innerHTML = `Остаток: <strong>${formatNumber(s.remaining)} ${ccy}</strong>`;

      const paidEl = document.createElement("div");
      paidEl.className = "cs-paid";
      paidEl.textContent = `Выплачено ${formatNumber(paid)} из ${
        formatNumber(s.principal)
      } ${ccy} (${pct}%)`;

      const bar = document.createElement("div");
      bar.className = "cs-bar";
      const fill = document.createElement("div");
      fill.className = "cs-bar-fill";
      fill.style.width = pct + "%";
      bar.appendChild(fill);

      card.appendChild(top);
      card.appendChild(remain);
      card.appendChild(paidEl);
      card.appendChild(bar);
      section.appendChild(card);
    }

    // Nearest upcoming payment within this group.
    let next = null;
    for (const c of list) {
      if (!c.next_payment_date) continue;
      if (!next || c.next_payment_date < next.date) {
        next = {
          date: c.next_payment_date,
          amount: c.monthly_payment != null ? Number(c.monthly_payment) : null,
          currency: c.currency,
          name: c.name,
        };
      }
    }
    if (next) {
      const row = document.createElement("div");
      row.className = "cs-next";
      const amountTxt = next.amount != null
        ? `${formatNumber(next.amount)} ${next.currency}`
        : "переменная сумма";
      row.innerHTML = `Ближайший платёж: <strong>${
        formatPlanDate(next.date)
      }</strong> · ${amountTxt} (${next.name})`;
      section.appendChild(row);
    }

    box.appendChild(section);
  }
}

function renderCredits() {
  renderCreditsStats();
  const list = $("#credits-list");
  if (!list) return;
  list.innerHTML = "";
  if (credits.items.length === 0) {
    const li = document.createElement("li");
    li.className = "credits-empty";
    li.textContent = "Кредитов пока нет.";
    list.appendChild(li);
    return;
  }
  for (const c of credits.items) {
    const li = document.createElement("li");
    li.className = "credit-row status-" + c.status;
    li.dataset.id = c.id;

    const head = document.createElement("div");
    head.className = "credit-row-head";
    const name = document.createElement("div");
    name.className = "credit-row-name";
    name.textContent = c.name;
    const type = document.createElement("div");
    type.className = "credit-row-type";
    type.textContent = CREDIT_TYPES[c.type] || c.type;
    head.appendChild(name);
    head.appendChild(type);

    const lender = document.createElement("div");
    lender.className = "credit-row-lender";
    lender.textContent = c.lender || "";

    const money = document.createElement("div");
    money.className = "credit-row-money";
    const amt = document.createElement("div");
    amt.className = "credit-amount";
    amt.textContent = `${formatNumber(c.remaining_balance)} / ${
      formatNumber(c.principal)
    } ${c.currency}`;
    const pct = document.createElement("div");
    pct.className = "credit-pct";
    pct.textContent = `${c.paid_pct}% выплачено`;
    money.appendChild(amt);
    money.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "credit-progress";
    const fill = document.createElement("div");
    fill.className = "credit-progress-fill";
    fill.style.width = c.paid_pct + "%";
    bar.appendChild(fill);

    const meta = document.createElement("div");
    meta.className = "credit-row-meta";
    const bits = [];
    if (c.monthly_payment) {
      bits.push(`платёж ${formatNumber(c.monthly_payment)} ${c.currency}/мес`);
    }
    if (c.interest_rate && Number(c.interest_rate) > 0) {
      bits.push(`${c.interest_rate}% годовых`);
    }
    if (c.next_payment_date) bits.push(`след. ${c.next_payment_date}`);
    meta.textContent = bits.join(" · ");

    li.appendChild(head);
    if (c.lender) li.appendChild(lender);
    li.appendChild(money);
    li.appendChild(bar);
    if (bits.length) li.appendChild(meta);

    li.addEventListener("click", () => openCreditForm(c));
    list.appendChild(li);
  }
}

function openCreditForm(item) {
  const modal = $("#credit-form-modal");
  if (!modal) return;
  credits.editingId = item ? item.id : null;
  $("#credit-form-title").textContent = item ? "Редактировать кредит" : "Новый кредит";
  $("#credit-form-type").value = item ? item.type : "cash_loan";
  $("#credit-form-name").value = item ? item.name : "";
  $("#credit-form-lender").value = item ? (item.lender || "") : "";
  $("#credit-form-principal").value = item ? item.principal : "";
  $("#credit-form-currency").value = item ? item.currency : "PLN";
  $("#credit-form-rate").value = item ? item.interest_rate : 0;
  $("#credit-form-term").value = item ? (item.term_months || "") : "";
  $("#credit-form-monthly").value = item ? (item.monthly_payment || "") : "";
  $("#credit-form-start").value = item ? item.start_date : new Date().toISOString().slice(0, 10);
  $("#credit-form-day").value = item ? (item.payment_day || "") : "";
  $("#credit-form-remaining").value = item ? item.remaining_balance : "";
  $("#credit-form-notes").value = item ? (item.notes || "") : "";
  $("#credit-form-for").value = item ? (item.borrowed_for || "") : "";
  $("#credit-form-autodebt").checked = item ? !!item.auto_create_debt : false;

  $("#credit-form-delete").classList.toggle("hidden", !item);
  $("#credit-form-pay").classList.toggle("hidden", !item || item.status === "closed");
  // "Apply to past payments" is meaningful only after the credit exists
  // AND has a configured borrowed_for + monthly_payment.
  const canLinkPast = !!item && !!item.borrowed_for && !!item.monthly_payment;
  $("#credit-form-link-past").classList.toggle("hidden", !canLinkPast);
  applyCreditTypeVisibility();
  modal.classList.remove("hidden");
}

function applyCreditTypeVisibility() {
  // Per-type field visibility: installment hides interest, credit_card
  // and overdraft hide term (open-ended), everything else shows all.
  const t = $("#credit-form-type").value;
  const rateLabel = document.querySelector(".credit-row-rate");
  const termLabel = document.querySelector(".credit-row-term");
  if (rateLabel) rateLabel.style.display = t === "installment" ? "none" : "";
  if (termLabel) {
    termLabel.style.display = (t === "credit_card" || t === "overdraft") ? "none" : "";
  }
  // Auto-suggest monthly payment when principal+term (+rate) are filled.
  const monthly = $("#credit-form-monthly");
  if (monthly && !monthly.value) {
    const p = parseFloat($("#credit-form-principal").value);
    const term = parseInt($("#credit-form-term").value, 10);
    const rate = t === "installment" ? 0 : parseFloat($("#credit-form-rate").value || "0");
    const calc = annuityPayment(p, rate, term);
    if (calc) monthly.placeholder = `≈ ${formatNumber(calc)}`;
  }
}

function closeCreditForm() {
  const modal = $("#credit-form-modal");
  if (modal) modal.classList.add("hidden");
  credits.editingId = null;
}

async function saveCreditForm() {
  const name = $("#credit-form-name").value.trim();
  const principal = parseFloat($("#credit-form-principal").value);
  if (!name || !(principal > 0)) {
    alert("Укажи название и сумму займа > 0.");
    return;
  }
  const term = parseInt($("#credit-form-term").value, 10);
  const monthly = parseFloat($("#credit-form-monthly").value);
  const rate = parseFloat($("#credit-form-rate").value);
  const day = parseInt($("#credit-form-day").value, 10);
  const remaining = parseFloat($("#credit-form-remaining").value);
  const payload = {
    name,
    type: $("#credit-form-type").value,
    lender: $("#credit-form-lender").value.trim() || null,
    principal,
    currency: $("#credit-form-currency").value,
    interest_rate: Number.isFinite(rate) ? rate : 0,
    start_date: $("#credit-form-start").value,
    term_months: Number.isFinite(term) ? term : null,
    monthly_payment: Number.isFinite(monthly) ? monthly : null,
    payment_day: Number.isFinite(day) ? day : null,
    remaining_balance: Number.isFinite(remaining) ? remaining : undefined,
    notes: $("#credit-form-notes").value.trim() || null,
    borrowed_for: $("#credit-form-for").value.trim() || null,
    auto_create_debt: $("#credit-form-autodebt").checked,
  };
  try {
    let resp;
    if (credits.editingId) {
      resp = await api("/api-credits?id=" + credits.editingId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await api("/api-credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeCreditForm();
    await loadCredits();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

async function deleteCreditForm() {
  if (!credits.editingId) return;
  if (!confirm("Удалить этот кредит и его историю платежей?")) return;
  try {
    const resp = await api("/api-credits?id=" + credits.editingId, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeCreditForm();
    await loadCredits();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

function openCreditPay() {
  if (!credits.editingId) return;
  const cred = credits.items.find((c) => c.id === credits.editingId);
  if (!cred) return;
  credits.payTarget = cred.id;
  $("#credit-pay-amount").value = cred.monthly_payment || "";
  $("#credit-pay-date").value = new Date().toISOString().slice(0, 10);
  $("#credit-pay-method").value = "transfer";
  $("#credit-pay-modal").classList.remove("hidden");
}
function closeCreditPay() {
  $("#credit-pay-modal").classList.add("hidden");
  credits.payTarget = null;
}
async function saveCreditPay() {
  if (!credits.payTarget) return;
  const amount = parseFloat($("#credit-pay-amount").value);
  if (!(amount > 0)) {
    alert("Сумма должна быть > 0.");
    return;
  }
  const payload = {
    amount,
    paid_at: $("#credit-pay-date").value,
    payment_method: $("#credit-pay-method").value,
  };
  try {
    const resp = await api(
      "/api-credits?id=" + credits.payTarget + "&action=payment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = await resp.json();
    if (!resp.ok || data.error) {
      // Stale view: credit already gone/closed server-side. Refresh truth.
      if (data.error === "not_found" || data.error === "credit_closed") {
        closeCreditPay();
        closeCreditForm();
        await loadCredits();
        alert("Кредит уже закрыт или изменён - обновил список.");
      } else {
        alert("Ошибка: " + (data.error || resp.status));
      }
      return;
    }
    closeCreditPay();
    closeCreditForm();
    await loadCredits();
    // Refresh transactions / KPIs since a new expense was just created.
    if (typeof refresh === "function") await refresh();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

async function linkCreditPastPayments() {
  if (!credits.editingId) return;
  if (
    !confirm(
      "Найти прошлые платежи по этому кредиту (за 6 месяцев) и создать долги? Дубликаты не создаются.",
    )
  ) return;
  try {
    const resp = await api(
      "/api-credits?id=" + credits.editingId + "&action=link_past_payments",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    alert(
      `Найдено платежей: ${data.scanned}. Создано долгов: ${data.created}.`,
    );
    closeCreditForm();
    await loadCredits();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

function bindCredits() {
  const add = $("#credit-add-btn");
  if (add) add.addEventListener("click", () => openCreditForm(null));
  for (const f of document.querySelectorAll(".credits-filter")) {
    f.addEventListener("click", () => {
      credits.filter = f.dataset.filter;
      for (const b of document.querySelectorAll(".credits-filter")) {
        b.classList.toggle("active", b === f);
      }
      // Stats stay the same across filter changes - they always reflect
      // the active subset - so just re-filter and re-render the list.
      applyCreditsFilter();
    });
  }
  const close = $("#credit-form-close");
  if (close) close.addEventListener("click", closeCreditForm);
  const bd = document.querySelector("#credit-form-modal .modal-backdrop");
  if (bd) bd.addEventListener("click", closeCreditForm);
  const cancel = $("#credit-form-cancel");
  if (cancel) cancel.addEventListener("click", closeCreditForm);
  const save = $("#credit-form-save");
  if (save) save.addEventListener("click", saveCreditForm);
  const del = $("#credit-form-delete");
  if (del) del.addEventListener("click", deleteCreditForm);
  const pay = $("#credit-form-pay");
  if (pay) pay.addEventListener("click", openCreditPay);
  const linkPast = $("#credit-form-link-past");
  if (linkPast) linkPast.addEventListener("click", linkCreditPastPayments);
  const typeSel = $("#credit-form-type");
  if (typeSel) typeSel.addEventListener("change", applyCreditTypeVisibility);
  for (const id of ["#credit-form-principal", "#credit-form-term", "#credit-form-rate"]) {
    const el = $(id);
    if (el) el.addEventListener("input", applyCreditTypeVisibility);
  }

  // Payment modal
  const pclose = $("#credit-pay-close");
  if (pclose) pclose.addEventListener("click", closeCreditPay);
  const pbd = document.querySelector("#credit-pay-modal .modal-backdrop");
  if (pbd) pbd.addEventListener("click", closeCreditPay);
  const pcancel = $("#credit-pay-cancel");
  if (pcancel) pcancel.addEventListener("click", closeCreditPay);
  const psave = $("#credit-pay-save");
  if (psave) psave.addEventListener("click", saveCreditPay);
}

// --- Debts ("🤝 Долги" tab) ------------------------------------------
// Two-directional debt tracking with payment recording that auto-
// creates the matching expense (when i_owe) or income (when owed_to_me)
// row.

const debts = {
  items: [],
  filter: "all", // all | i_owe | owed_to_me
  editingId: null,
  direction: "i_owe",
  payTarget: null,
};

async function loadDebts() {
  try {
    const params = debts.filter === "all" ? "?status=all" : `?direction=${debts.filter}&status=all`;
    const r = await api("/api-debts" + params).then((x) => x.json());
    debts.items = r.items || [];
  } catch (e) {
    if (isSessionExpired(e)) return;
    debts.items = [];
  }
  renderDebts();
}

function renderDebts() {
  const list = $("#debts-list");
  if (!list) return;
  list.innerHTML = "";
  if (debts.items.length === 0) {
    const li = document.createElement("li");
    li.className = "credits-empty";
    li.textContent = "Долгов пока нет.";
    list.appendChild(li);
    return;
  }
  for (const d of debts.items) {
    const li = document.createElement("li");
    li.className = "credit-row debt-" + d.direction;
    if (d.status === "closed") li.classList.add("status-closed");
    if (d.is_overdue || d.status === "overdue") li.classList.add("is-overdue");
    li.dataset.id = d.id;

    const head = document.createElement("div");
    head.className = "credit-row-head";
    const name = document.createElement("div");
    name.className = "credit-row-name";
    name.textContent = (d.direction === "i_owe" ? "Кому: " : "От кого: ") + d.counterparty;
    const tag = document.createElement("div");
    tag.className = "credit-row-type";
    tag.textContent = d.direction === "i_owe" ? "ДОЛЖЕН Я" : "ДОЛЖНЫ МНЕ";
    head.appendChild(name);
    head.appendChild(tag);

    const money = document.createElement("div");
    money.className = "credit-row-money";
    const amt = document.createElement("div");
    amt.className = "credit-amount";
    amt.textContent = `${formatNumber(d.remaining_balance)} / ${
      formatNumber(d.amount)
    } ${d.currency}`;
    const pct = document.createElement("div");
    pct.className = "credit-pct";
    pct.textContent = d.status === "closed" ? "погашено" : `${d.paid_pct}% возвращено`;
    money.appendChild(amt);
    money.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "credit-progress";
    const fill = document.createElement("div");
    fill.className = "credit-progress-fill";
    fill.style.width = d.paid_pct + "%";
    bar.appendChild(fill);

    const meta = document.createElement("div");
    meta.className = "credit-row-meta";
    const bits = [];
    if (d.due_date) {
      if (d.is_overdue) bits.push(`просрочено: ${d.due_date}`);
      else if (d.days_to_due === 0) bits.push("срок сегодня");
      else if (d.days_to_due > 0) bits.push(`до срока: ${d.days_to_due} дн.`);
    }
    bits.push("взято: " + d.borrowed_at);
    meta.textContent = bits.join(" · ");

    li.appendChild(head);
    li.appendChild(money);
    li.appendChild(bar);
    li.appendChild(meta);

    li.addEventListener("click", () => openDebtForm(d));
    list.appendChild(li);
  }
}

function setDebtDirection(dir) {
  debts.direction = dir;
  for (const b of document.querySelectorAll(".debt-dir-btn")) {
    b.classList.toggle("active", b.dataset.dir === dir);
  }
  const lbl = $("#debt-form-cp-label");
  if (lbl) {
    lbl.firstChild.textContent = dir === "i_owe" ? "Кому должен" : "Кто должен";
  }
}

function openDebtForm(item) {
  const modal = $("#debt-form-modal");
  if (!modal) return;
  debts.editingId = item ? item.id : null;
  setDebtDirection(item ? item.direction : "i_owe");

  $("#debt-form-title").textContent = item ? "Редактировать долг" : "Новый долг";
  $("#debt-form-amount").value = item ? item.amount : "";
  $("#debt-form-currency").value = item ? item.currency : "PLN";
  $("#debt-form-counterparty").value = item ? item.counterparty : "";
  $("#debt-form-borrowed").value = item ? item.borrowed_at : new Date().toISOString().slice(0, 10);
  $("#debt-form-due").value = item && item.due_date ? item.due_date : "";
  $("#debt-form-remaining").value = item ? item.remaining_balance : "";
  $("#debt-form-notes").value = item && item.notes ? item.notes : "";
  $("#debt-form-notify-3d").checked = item ? !!item.notify_3d_before : true;
  $("#debt-form-notify-due").checked = item ? !!item.notify_on_due : true;
  $("#debt-form-notify-overdue").checked = item ? !!item.notify_overdue : true;

  $("#debt-form-delete").classList.toggle("hidden", !item);
  $("#debt-form-pay").classList.toggle("hidden", !item || item.status === "closed");
  modal.classList.remove("hidden");
}

function closeDebtForm() {
  $("#debt-form-modal").classList.add("hidden");
  debts.editingId = null;
}

async function saveDebtForm() {
  const counterparty = $("#debt-form-counterparty").value.trim();
  const amount = parseFloat($("#debt-form-amount").value);
  if (!counterparty || !(amount > 0)) {
    alert("Укажи контрагента и сумму > 0.");
    return;
  }
  const remaining = parseFloat($("#debt-form-remaining").value);
  const due = $("#debt-form-due").value || null;
  const payload = {
    direction: debts.direction,
    counterparty,
    amount,
    currency: $("#debt-form-currency").value,
    remaining_balance: Number.isFinite(remaining) ? remaining : undefined,
    borrowed_at: $("#debt-form-borrowed").value,
    due_date: due,
    notify_3d_before: $("#debt-form-notify-3d").checked,
    notify_on_due: $("#debt-form-notify-due").checked,
    notify_overdue: $("#debt-form-notify-overdue").checked,
    notes: $("#debt-form-notes").value.trim() || null,
  };
  try {
    let resp;
    if (debts.editingId) {
      resp = await api("/api-debts?id=" + debts.editingId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await api("/api-debts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeDebtForm();
    await loadDebts();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

async function deleteDebtForm() {
  if (!debts.editingId) return;
  if (!confirm("Удалить этот долг и историю платежей?")) return;
  try {
    const resp = await api("/api-debts?id=" + debts.editingId, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert("Ошибка: " + (data.error || resp.status));
      return;
    }
    closeDebtForm();
    await loadDebts();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

function openDebtPay() {
  if (!debts.editingId) return;
  const d = debts.items.find((x) => x.id === debts.editingId);
  if (!d) return;
  debts.payTarget = d.id;
  $("#debt-pay-title").textContent = d.direction === "i_owe"
    ? "Зафиксировать выплату"
    : "Зафиксировать возврат";
  let hint = d.direction === "i_owe"
    ? "Создастся запись расхода в счёт долга и уменьшится остаток."
    : "Создастся запись дохода (возврат долга) и уменьшится остаток.";
  if (d.direction === "owed_to_me" && d.source_credit_name) {
    hint += ` Также уменьшится остаток по кредиту "${d.source_credit_name}" на ту же сумму.`;
  }
  $("#debt-pay-hint").textContent = hint;
  $("#debt-pay-amount").value = d.remaining_balance;
  $("#debt-pay-date").value = new Date().toISOString().slice(0, 10);
  $("#debt-pay-method").value = "transfer";
  $("#debt-pay-modal").classList.remove("hidden");
}

function closeDebtPay() {
  $("#debt-pay-modal").classList.add("hidden");
  debts.payTarget = null;
}

async function saveDebtPay() {
  if (!debts.payTarget) return;
  const amount = parseFloat($("#debt-pay-amount").value);
  if (!(amount > 0)) {
    alert("Сумма должна быть > 0.");
    return;
  }
  const payload = {
    amount,
    paid_at: $("#debt-pay-date").value,
    payment_method: $("#debt-pay-method").value,
  };
  try {
    const resp = await api(
      "/api-debts?id=" + debts.payTarget + "&action=payment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = await resp.json();
    if (!resp.ok || data.error) {
      // Stale view: the debt was already fully repaid (closed) server-side but
      // the cached list still showed it open. Refresh so the truth shows.
      if (data.error === "debt_closed" || data.error === "not_found") {
        closeDebtPay();
        closeDebtForm();
        await loadDebts();
        alert("Этот долг уже погашен - обновил список.");
      } else {
        alert("Ошибка: " + (data.error || resp.status));
      }
      return;
    }
    closeDebtPay();
    closeDebtForm();
    await loadDebts();
    // Credit balance might have been auto-reduced if the debt traced
    // back to a credit; refresh the credits list cache so it shows up.
    if (data.credit_applied && typeof loadCredits === "function") {
      await loadCredits();
    }
    if (typeof refresh === "function") await refresh();
  } catch (e) {
    if (!isSessionExpired(e)) alert("Сеть недоступна.");
  }
}

function bindDebts() {
  const add = $("#debt-add-btn");
  if (add) add.addEventListener("click", () => openDebtForm(null));
  for (const f of document.querySelectorAll(".debts-filter")) {
    f.addEventListener("click", () => {
      debts.filter = f.dataset.filter;
      for (const b of document.querySelectorAll(".debts-filter")) {
        b.classList.toggle("active", b === f);
      }
      loadDebts();
    });
  }
  for (const b of document.querySelectorAll(".debt-dir-btn")) {
    b.addEventListener("click", () => setDebtDirection(b.dataset.dir));
  }
  const close = $("#debt-form-close");
  if (close) close.addEventListener("click", closeDebtForm);
  const bd = document.querySelector("#debt-form-modal .modal-backdrop");
  if (bd) bd.addEventListener("click", closeDebtForm);
  const cancel = $("#debt-form-cancel");
  if (cancel) cancel.addEventListener("click", closeDebtForm);
  const save = $("#debt-form-save");
  if (save) save.addEventListener("click", saveDebtForm);
  const del = $("#debt-form-delete");
  if (del) del.addEventListener("click", deleteDebtForm);
  const pay = $("#debt-form-pay");
  if (pay) pay.addEventListener("click", openDebtPay);

  const pclose = $("#debt-pay-close");
  if (pclose) pclose.addEventListener("click", closeDebtPay);
  const pbd = document.querySelector("#debt-pay-modal .modal-backdrop");
  if (pbd) pbd.addEventListener("click", closeDebtPay);
  const pcancel = $("#debt-pay-cancel");
  if (pcancel) pcancel.addEventListener("click", closeDebtPay);
  const psave = $("#debt-pay-save");
  if (psave) psave.addEventListener("click", saveDebtPay);
}

async function main() {
  // Magic-link exchange must run before gate check so the URL token is
  // converted into a stored session in time for gateOrApp() to see it.
  await bootstrapMagic();

  if (!gateOrApp()) return;
  if (TG.themeAttach) TG.themeAttach();

  if (TG.user && TG.user.first_name) $("#hello").textContent = "FinBot, " + TG.user.first_name;

  bindNav();
  bindSettings();
  bindPlanning();
  bindPaymentCalendar();
  bindCredits();
  bindDebts();

  await loadCategoriesAndFamily();
  await refresh();

  // Category-picker modal close handlers
  $("#cat-modal-close").addEventListener("click", closeCategoryPicker);
  document.querySelector("#cat-modal .modal-backdrop")
    .addEventListener("click", closeCategoryPicker);

  // Filter chips above transactions
  const filterCat = $("#filter-category");
  const filterMem = $("#filter-member");
  const filterSrc = $("#filter-source");
  if (filterCat) {
    // Fill category options (sorted same as state.byCategory if available, else by name)
    const cats = [...state.categories.values()].sort((a, b) => {
      if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1;
      return a.name.localeCompare(b.name, "ru");
    });
    for (const c of cats) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      filterCat.appendChild(o);
    }
    filterCat.addEventListener("change", () => {
      state.txFilterCategory = filterCat.value;
      loadTransactions(true);
    });
  }
  if (filterMem) {
    for (const fm of state.family.values()) {
      const o = document.createElement("option");
      o.value = fm.id;
      o.textContent = fm.name;
      filterMem.appendChild(o);
    }
    filterMem.addEventListener("change", () => {
      state.txFilterMember = filterMem.value;
      loadTransactions(true);
    });
  }
  if (filterSrc) {
    filterSrc.addEventListener("change", () => {
      state.txFilterSource = filterSrc.value;
      loadTransactions(true);
    });
  }
  $("#filter-reset").addEventListener("click", () => {
    state.txFilterCategory = "";
    state.txFilterMember = "";
    state.txFilterSource = "";
    state.filterReconciled = false;
    if (filterCat) filterCat.value = "";
    if (filterMem) filterMem.value = "";
    if (filterSrc) filterSrc.value = "";
    const recBtn = $("#filter-reconciled");
    if (recBtn) recBtn.classList.remove("active");
    loadTransactions(true);
  });

  const recBtn = $("#filter-reconciled");
  if (recBtn) {
    recBtn.addEventListener("click", () => {
      state.filterReconciled = !state.filterReconciled;
      recBtn.classList.toggle("active", state.filterReconciled);
      // Re-render in place - we already have the data, just filter client-side.
      renderTransactions();
    });
  }

  // Photo-modal close
  $("#photo-modal-close").addEventListener("click", closePhotoModal);
  document.querySelector("#photo-modal .modal-backdrop")
    .addEventListener("click", closePhotoModal);

  // Category-add/edit form modal. Add buttons live in the Settings panel,
  // one per kind, so the modal is pre-seeded with the right kind on open.
  const addExpense = $("#settings-add-expense");
  if (addExpense) addExpense.addEventListener("click", () => openCategoryForm(null, "expense"));
  const addIncome = $("#settings-add-income");
  if (addIncome) addIncome.addEventListener("click", () => openCategoryForm(null, "income"));
  $("#cat-form-close").addEventListener("click", closeCategoryForm);
  $("#cat-form-cancel").addEventListener("click", closeCategoryForm);
  document.querySelector("#cat-form-modal .modal-backdrop")
    .addEventListener("click", closeCategoryForm);
  $("#cat-form-save").addEventListener("click", submitCategoryForm);

  // Period tabs
  const customBox = $("#custom-range");
  const fromInput = $("#range-from");
  const toInput = $("#range-to");
  const monthBox = $("#month-picker");
  const monthSelect = $("#month-select");
  // Default the date inputs to current month so the user only has to tap.
  const todayIso = new Date().toISOString().slice(0, 10);
  toInput.value = todayIso;
  fromInput.value = todayIso.slice(0, 7) + "-01";

  // Populate month picker with last 12 months. Newest first; current first.
  const RU_MONTHS = [
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь",
  ];
  monthSelect.innerHTML = "";
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const ym = `${y}-${String(m + 1).padStart(2, "0")}`;
    const o = document.createElement("option");
    o.value = ym;
    o.textContent = `${RU_MONTHS[m]} ${y}`;
    if (ym === state.month) o.selected = true;
    monthSelect.appendChild(o);
  }
  // Initially "Месяц" is the active default tab, so show the picker.
  monthBox.classList.remove("hidden");

  monthSelect.addEventListener("change", () => {
    state.month = monthSelect.value;
    state.period = "month";
    refresh();
  });

  document.querySelectorAll(".period-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".period-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const p = btn.dataset.period;
      if (p === "custom") {
        customBox.classList.remove("hidden");
        monthBox.classList.add("hidden");
        return;
      }
      customBox.classList.add("hidden");
      if (p === "month") {
        // Snap month picker back to current month and show it.
        state.month = todayMonth();
        monthSelect.value = state.month;
        monthBox.classList.remove("hidden");
      } else {
        monthBox.classList.add("hidden");
      }
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
      if (!isSessionExpired(e)) TG.showAlert("Не удалось скачать CSV.");
    }
  });
}

main().catch((e) => {
  console.error(e);
  if (window.TG && TG.showAlert) TG.showAlert("Ошибка: " + e.message);
});
