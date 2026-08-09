// 应用入口：全局状态、hash 路由、顶栏时间窗切换、健康灯、自动刷新、图表尺寸管理。
window.GM = (function () {
  const state = { meta: { windows: ["12h", "24h", "48h", "72h", "1w", "2w", "1m"] }, window: "24h", theme: "dark" };
  let charts = [];        // 当前视图的 ECharts 实例，切换视图前统一 dispose
  let refreshTimer = null;

  function go(path) { location.hash = "#" + path; }
  function crumb(text) { document.getElementById("crumb").textContent = text; }
  function onResize(chart) { charts.push(chart); }
  function disposeCharts() { charts.forEach((c) => { try { c.dispose(); } catch (e) {} }); charts = []; }

  function applyTheme() {
    document.body.dataset.theme = state.theme === "light" ? "light" : "dark";
  }

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    localStorage.setItem("gpumon.theme", state.theme);
    applyTheme();
    buildThemeSwitch();
    render();
  }

  function parseRoute() {
    const h = location.hash.replace(/^#/, "") || "/";
    const seg = h.split("/").filter(Boolean);     // ["cluster","h200"]
    if (seg.length === 0) return { view: "overview", params: {} };
    if (seg[0] === "cluster") return { view: "cluster", params: { key: decodeURIComponent(seg[1]) } };
    if (seg[0] === "host") return { view: "host", params: { key: decodeURIComponent(seg[1]) } };
    if (seg[0] === "gpu") return { view: "gpu", params: { id: seg[1] } };
    if (seg[0] === "ranking") return { view: "ranking", params: {} };
    return { view: "overview", params: {} };
  }

  async function render() {
    const route = parseRoute();
    const root = document.getElementById("view");
    const nav = document.getElementById("navRank");
    if (nav) nav.classList.toggle("active", route.view === "ranking");
    disposeCharts();
    try {
      await Views[route.view].render(root, route.params);
    } catch (e) {
      root.innerHTML = `<div class="panel"><h3>加载失败</h3><div class="note">${e.message}</div></div>`;
      console.error(e);
    }
    scheduleRefresh(route.view);
  }

  // 仅总览页自动刷新，避免打断下钻页的交互（如指标切换）
  function scheduleRefresh(view) {
    if (refreshTimer) clearInterval(refreshTimer);
    if (view === "overview") {
      refreshTimer = setInterval(() => { if (parseRoute().view === "overview") render(); },
        (state.meta.poll_interval_s || 30) * 1000);
    }
  }

  function buildWinSwitch() {
    const box = document.getElementById("winSwitch");
    box.innerHTML = "";
    state.meta.windows.forEach((w) => {
      const b = UI.el("button", {
        class: w === state.window ? "active" : "",
        onclick: () => { state.window = w; buildWinSwitch(); render(); },
      }, [w]);
      box.appendChild(b);
    });
  }

  function buildThemeSwitch() {
    const box = document.getElementById("themeSwitch");
    if (!box) return;
    box.innerHTML = "";
    [["dark", "夜间"], ["light", "日间"]].forEach(([key, label]) => {
      const b = UI.el("button", {
        class: key === state.theme ? "active" : "",
        onclick: () => setTheme(key),
      }, [label]);
      box.appendChild(b);
    });
  }

  async function pollHealth() {
    const dot = document.getElementById("hdot");
    const txt = document.getElementById("htext");
    try {
      const [st, hl] = await Promise.all([API.collectorStatus(), API.health()]);
      const activeHosts = st.hosts.filter((h) => h.status !== "planned");
      const online = activeHosts.filter((h) => h.online).length;
      const total = activeHosts.length;
      const age = hl.last_sample_age_s;
      let cls = "green";
      if (online === 0 || age == null) cls = "red";
      else if (online < total || (age != null && age > 90)) cls = "yellow";
      dot.className = "dot " + cls;
      txt.textContent = `在线 ${online}/${total} · 数据 ${UI.ago(hl.last_sample_ts)}`;
      dot.parentElement.title = activeHosts.map((h) =>
        `${h.display_name}: ${h.online ? "在线" : "离线"} ${h.gpus_seen ?? 0}/${h.gpus_expected}卡` +
        (h.last_error ? " (" + h.last_error + ")" : "")).join("\n");
    } catch (e) {
      dot.className = "dot red"; txt.textContent = "服务不可达";
    }
  }

  async function init() {
    state.theme = localStorage.getItem("gpumon.theme") === "light" ? "light" : "dark";
    applyTheme();
    try { state.meta = await API.meta(); } catch (e) {}
    // 把"算力域 → 色带"映射交给 Palette，之后所有身份色都按 inventory 配置走
    UI.Palette.setGroups(state.meta.capacity_groups);
    if (!state.meta.windows.includes(state.window)) state.window = state.meta.windows[1] || state.meta.windows[0];
    buildThemeSwitch();
    buildWinSwitch();
    window.addEventListener("hashchange", render);
    window.addEventListener("resize", () => charts.forEach((c) => { try { c.resize(); } catch (e) {} }));
    document.getElementById("title").onclick = () => go("/");
    document.getElementById("navRank").onclick = () => go("/ranking");
    document.querySelector(".health").onclick = () => go("/");
    await render();
    pollHealth();
    setInterval(pollHealth, 15000);
  }

  return { state, go, crumb, onResize, init };
})();

document.addEventListener("DOMContentLoaded", GM.init);
