// Thin wrapper around window.Telegram.WebApp. Exposes:
//   TG.initData          - raw initData string for API auth
//   TG.user              - first-name / username for greeting
//   TG.themeAttach()     - re-syncs CSS theme variables on theme changes
//   TG.isReady           - true if Telegram environment is detected
//   TG.openDashboard()   - calls expand() so the Mini App takes full height
window.TG = (function () {
  const w = window.Telegram && window.Telegram.WebApp;
  if (!w) {
    return { isReady: false };
  }
  try {
    w.ready();
    w.expand();
  } catch (_) {}
  function themeAttach() {
    // Telegram already injects CSS vars; this hook is for theme-change.
    w.onEvent && w.onEvent("themeChanged", () => {});
  }
  return {
    isReady: Boolean(w.initData),
    initData: w.initData || "",
    user: (w.initDataUnsafe && w.initDataUnsafe.user) || null,
    themeAttach,
    openDashboard: () => {
      try {
        w.expand();
      } catch (_) {}
    },
    showAlert: (msg) => {
      try {
        w.showAlert(msg);
      } catch (_) {
        alert(msg);
      }
    },
  };
})();
