// Load before the application: this fallback must work without UI, I18n or ECharts.
window.PageRecovery = (function () {
  // Version-pinned assets identify what this tab actually loaded, including old tabs.
  const loadedVersion = (document.currentScript?.src || '').match(/\/_frontend\/([a-f0-9]{64})\//)?.[1];
  let checkedAt = 0, checking = false;
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

  async function checkVersion() {
    if (!loadedVersion || checking || Date.now() - checkedAt < 60000) return;
    checking = true; checkedAt = Date.now();
    try {
      const response = await fetch(new URL('/api/frontend-release', location.origin), {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data.protocol !== 1 || !/^[a-f0-9]{64}$/.test(data.version)) return;
      if (data.version === loadedVersion) { document.getElementById('frontend-update')?.remove(); return; }
      let banner = document.getElementById('frontend-update');
      if (!banner) {
        banner = document.createElement('div'); banner.id = 'frontend-update'; banner.className = 'page-recovery';
        banner.setAttribute('role', 'status'); document.body.prepend(banner);
      }
      const english = window.I18n ? I18n.getLocale() === 'en' : document.documentElement.lang.startsWith('en');
      banner.textContent = english ? 'A new frontend version is available. Reload when ready; your current view remains open.'
        : '前端已有新版本，可在方便时重载刷新；当前页面会继续保留。';
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = english ? 'Reload' : '重载刷新'; button.onclick = () => location.reload();
      banner.appendChild(button);
    } catch (_) { /* A failed version check must not interrupt data refresh. */ }
    finally { checking = false; }
  }

  window.addEventListener("error", function (event) {
    // Resource errors do not bubble. Only failed scripts/styles threaten page rendering.
    const target = event.target;
    if (target === window || target?.tagName === "SCRIPT" ||
        (target?.tagName === "LINK" && target.rel === "stylesheet")) show();
  }, true);
  window.addEventListener("unhandledrejection", show);
  return { show, message, checkVersion };
})();
