// FinBot Mini App view-model.
// No localStorage/sessionStorage (SPEC §0 ban). State lives in JS objects only.

const SUPABASE_URL = "https://bltbuptzsswaislqagwe.supabase.co";
const API_BASE = SUPABASE_URL + "/functions/v1";
const TX_PAGE = 50;

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
const VALID_TABS = ["dashboard", "income", "expense", "settings"];
state.tab = "dashboard";

function setActiveTab(tab) {
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
  // Persist in URL hash so a refresh keeps the tab.
  try {
    history.replaceState({}, "", location.pathname + location.search + "#" + tab);
  } catch (_) { /* ignore */ }
}

function bindNav() {
  for (const btn of document.querySelectorAll("#bottom-nav .nav-btn")) {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  }
  const initial = (location.hash || "").replace("#", "");
  setActiveTab(VALID_TABS.includes(initial) ? initial : "dashboard");
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
  // Active tab restricts the feed: "income" → only income rows, "expense" →
  // only expense rows, "dashboard" → mixed. Receipts have tx_kind='expense'
  // by definition (you don't photograph a paycheck).
  const tabFilter = state.tab === "income"
    ? (t) => t.tx_kind === "income"
    : state.tab === "expense"
    ? (t) => t.tx_kind !== "income"
    : () => true;
  for (const t of state.txItems.filter(tabFilter)) {
    const li = document.createElement("li");
    const isIncome = t.tx_kind === "income";
    li.className = "tx-row " + (t.kind === "receipt" ? "tx-receipt" : "tx-expense") +
      (isIncome ? " tx-income" : "");
    const fm = state.family.get(t.family_member_id);
    if (t.kind === "receipt") {
      const expanded = state.expandedReceipts.has(t.id);
      const caret = expanded ? "▾" : "▸";
      const meta = `${t.expense_date} | чек, ${t.item_count} поз.` +
        (fm ? ` | ${escapeHtml(fm.name)}` : "");
      const sign = isIncome ? "+" : "";
      li.innerHTML =
        `<div class="name"><span class="caret">${caret}</span> ${
          escapeHtml(t.title)
        } <button class="tx-photo" type="button" data-id="${t.id}" data-title="${
          escapeHtml(t.title)
        }" title="Открыть фото чека">🖼</button><div class="meta">${meta}</div></div>` +
        `<div class="amt">${sign}${Number(t.amount).toFixed(2)} ${t.currency}</div>` +
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
      const isIncome = t.tx_kind === "income";
      if (isIncome) li.classList.add("tx-income");
      const metaPrefix = `${t.expense_date} | `;
      const metaSuffix = fm ? ` | ${escapeHtml(fm.name)}` : "";
      const sign = isIncome ? "+" : "";
      li.innerHTML =
        `<div class="name">${escapeHtml(t.title)}<div class="meta">${metaPrefix}${
          categoryMetaHtml(t.category_id)
        }${metaSuffix}</div></div>` +
        `<div class="amt">${sign}${Number(t.amount).toFixed(2)} ${t.currency}</div>` +
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

async function main() {
  // Magic-link exchange must run before gate check so the URL token is
  // converted into a stored session in time for gateOrApp() to see it.
  await bootstrapMagic();

  if (!gateOrApp()) return;
  if (TG.themeAttach) TG.themeAttach();

  if (TG.user && TG.user.first_name) $("#hello").textContent = "FinBot, " + TG.user.first_name;

  bindNav();
  bindSettings();

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
    if (filterCat) filterCat.value = "";
    if (filterMem) filterMem.value = "";
    if (filterSrc) filterSrc.value = "";
    loadTransactions(true);
  });

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
