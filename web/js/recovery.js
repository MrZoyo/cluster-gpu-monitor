// Load before the application: this fallback must work without UI, I18n or ECharts.
window.PageRecovery = (function () {
  function message() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
    const shortcut = /mac|iphone|ipad|ipod/i.test(platform) ? "Command+Shift+R" : "Ctrl+Shift+R";
    let english = document.documentElement.lang.startsWith("en");
    try { if (window.I18n) english = I18n.getLocale() === "en"; } catch (_) { /* Partially loaded application. */ }
    return english
      ? `The page may have been updated. Press ${shortcut} to force reload. If the problem persists, contact your administrator.`
      : `网页可能已经更新，请使用 ${shortcut} 进行强制重载刷新；如果依然不行，请联系管理员。`;
  }

  function show() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", show, { once: true });
      return;
    }
    let banner = document.getElementById("page-recovery");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "page-recovery";
      banner.className = "page-recovery";
      banner.setAttribute("role", "alert");
      document.body.prepend(banner);
    }
    // Error messages may contain server responses or user data; don't insert them into the UI.
    banner.textContent = message();
  }

  window.addEventListener("error", function (event) {
    // Resource errors do not bubble. Only failed scripts/styles threaten page rendering.
    const target = event.target;
    if (target === window || target?.tagName === "SCRIPT" ||
        (target?.tagName === "LINK" && target.rel === "stylesheet")) show();
  }, true);
  window.addEventListener("unhandledrejection", show);
  return { show, message };
})();
