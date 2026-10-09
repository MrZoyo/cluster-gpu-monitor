// 应用入口：全局状态、hash 路由、顶栏时间窗切换、健康灯、自动刷新、图表尺寸管理。
window.GM = (function () {
  const state = { meta: null, window: "24h", theme: "dark", paiEnabled: false };
  let renderGeneration = 0;
  let charts = [];        // 当前视图的 ECharts 实例，切换视图前统一 dispose
  let refreshTimer = null;

  function go(path) { location.hash = "#" + path; }
  // 裸金属总览的地址：未启用 PAI 时就是根路径，界面与原版完全一致；启用后根路径是双入口首页。
  function overviewPath() { return state.paiEnabled ? "/baremetal" : "/"; }
  function crumb(text) {
    const node = document.getElementById("crumb");
    node.textContent = text;
    node.title = text;
  }

  function buildLangSwitch() {
    const box = document.getElementById("langSwitch");
    if (!box) return;
    box.innerHTML = "";
    const btn = UI.el("button", {
      class: "lang-btn",
      title: I18n.getLocale() === 'zh' ? '切换语言 / Switch Language' : 'Switch Language / 切换语言',
      onclick: () => {
        const dropdown = box.querySelector(".lang-dropdown");
        if (dropdown) {
          dropdown.remove();
        } else {
          showLangDropdown(box);
        }
      },
    }, []);
    const icon = document.createElement("img");
    icon.src = "icons/globe.svg";
    icon.className = "topbar-icon";
    btn.appendChild(icon);
    box.appendChild(btn);
  }

  function showLangDropdown(container) {
    const dropdown = UI.el("div", { class: "lang-dropdown" }, [
      UI.el("div", {
        class: "lang-option" + (I18n.getLocale() === 'zh' ? ' active' : ''),
        onclick: () => { I18n.setLocale('zh'); dropdown.remove(); },
      }, ["中文"]),
      UI.el("div", {
        class: "lang-option" + (I18n.getLocale() === 'en' ? ' active' : ''),
        onclick: () => { I18n.setLocale('en'); dropdown.remove(); },
      }, ["English"]),
    ]);
    container.appendChild(dropdown);
    // 点击外部关闭
    setTimeout(() => {
      const close = (e) => {
        if (!container.contains(e.target)) {
          dropdown.remove();
          document.removeEventListener("click", close);
        }
      };
      document.addEventListener("click", close);
    }, 0);
  }
  function onResize(chart) { charts.push(chart); }
  function disposeCharts() { charts.forEach((c) => { try { c.dispose(); } catch (e) {} }); charts = []; }

  function updateDemoBanner() {
    const title = document.getElementById("demo-banner-title");
    const text = document.getElementById("demo-banner-text");
    const link = document.getElementById("demo-banner-link");
    if (title) title.textContent = I18n.t('demo_banner_title');
    if (text) text.textContent = I18n.t('demo_banner_text');
    if (link) link.textContent = I18n.t('demo_banner_link');
  }

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
    if (seg.length === 0) return { view: state.paiEnabled ? "home" : "overview", params: {} };
    if (seg[0] === "pai") {
      // 未启用 PAI 时，PAI 地址一律回到裸金属总览，不显示任何 PAI 页面。
      if (!state.paiEnabled) return { view: "overview", params: {}, redirect: "/" };
      return { view: "pai", params: { tab: seg[1] || "overview", id: seg.slice(2).map(decodeURIComponent).join("/") } };
    }
    if (seg[0] === "baremetal") seg.shift();
    if (seg.length === 0) return { view: "overview", params: {} };
    if (seg[0] === "cluster") return { view: "cluster", params: { key: decodeURIComponent(seg[1]) } };
    if (seg[0] === "host") return { view: "host", params: { key: decodeURIComponent(seg[1]) } };
    if (seg[0] === "gpu") return { view: "gpu", params: { id: seg[1] } };
    if (seg[0] === "ranking") return { view: "ranking", params: {} };
    return { view: "overview", params: {} };
  }

  // soft=true 用于定时刷新：保持页面高度与滚动位置，避免每两分钟跳回顶部。
  async function render(opts) {
    const soft = !!(opts && opts.soft === true);
    const generation = ++renderGeneration;
    if (refreshTimer) clearTimeout(refreshTimer);
    const route = parseRoute();
    if (route.redirect) { history.replaceState(null, "", "#" + route.redirect); }
    const view = document.getElementById("view");
    const scrollY = window.scrollY;
    view.style.minHeight = soft ? view.offsetHeight + "px" : "";
    const root = UI.el("div", {}, []);
    view.replaceChildren(root);
    buildModuleNav(route.view, route.params);
    disposeCharts();
    try {
      await Views[route.view].render(root, route.params);
    } catch (e) {
      if (generation !== renderGeneration) return;
      root.innerHTML = "";
      root.appendChild(UI.el("div", { class: "panel" }, [
        UI.el("h3", {}, [I18n.t('load_failed')]),
        UI.el("div", { class: "note" }, [PageRecovery.message()]),
      ]));
      PageRecovery.show();
      console.error(e);
    }
    if (generation !== renderGeneration) return;
    if (soft) { view.style.minHeight = ""; window.scrollTo(0, scrollY); }
    scheduleRefresh(route.view);
    pollHealth();
  }

  function scheduleRefresh(view) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const seconds = view === "overview" ? (state.meta.poll_interval_s || 30)
      : ["home", "pai"].includes(view) ? 120 : null;
    if (!seconds) return;
    refreshTimer = setTimeout(function tick() {
      // 正在输入搜索词时推迟刷新，避免打断输入。
      if (document.activeElement && document.activeElement.matches("#view input")) {
        refreshTimer = setTimeout(tick, 30000);
        return;
      }
      render({ soft: true });
    }, seconds * 1000);
  }

  // 模块切换放在顶栏：标题回首页，分段按钮切裸金属 / PAI。
  function buildModuleNav(view, params) {
    const box = document.getElementById("moduleNav");
    const zh = I18n.getLocale() === "zh";
    if (box) {
      box.hidden = !state.paiEnabled;
      box.replaceChildren(...(state.paiEnabled ? [["/baremetal", zh ? "裸金属" : "Bare metal", "baremetal"], ["/pai", "PAI", "pai"]]
        .map(([path, label, key]) => {
          const active = key === "pai" ? view === "pai" : !["home", "pai"].includes(view);
          return UI.el("button", { class: active ? "active" : "", "aria-current": active ? "page" : null, onclick: () => go(path) }, [label]);
        }) : []));
    }
    const baremetal = !["home", "pai"].includes(view);
    const notice = document.getElementById("sourceNotice");
    notice.textContent = state.baremetalNotice || "";
    notice.hidden = !state.baremetalNotice || !baremetal;
    // 顶栏时间窗用于裸金属；PAI 排行使用独立的周报时间窗。
    document.querySelector(".topbar-window").hidden = !baremetal;
    document.getElementById("navRankText").textContent = view === "pai" ? (zh ? "排行" : "Ranking") : I18n.t("user_ranking");
    // 顶栏排行入口跟随当前模块，首页通过模块卡片进入。
    const navRank = document.getElementById("navRank");
    navRank.hidden = view === "home";
    const onRanking = view === "ranking" || (view === "pai" && !!params && params.tab === "ranking");
    navRank.classList.toggle("active", onRanking);
    navRank.title = onRanking ? (I18n.getLocale() === "zh" ? "再点一次返回总览" : "Click again to return to the overview") : "";
  }

  // 首页 / PAI 页的顶栏状态灯由视图在读取快照后写入，不额外轮询云端或快照接口。
  function setSourceHealth(source, sourceState, ts) {
    state.sourceHealth = state.sourceHealth || {};
    state.sourceHealth[source] = { state: sourceState, ts };
    pollHealth();
  }

  function buildWinSwitch() {
    const box = document.getElementById("winSwitch");
    box.innerHTML = "";
    state.meta.windows.forEach((w) => {
      const b = UI.el("button", {
        class: w === state.window ? "active" : "",
        onclick: () => {
          state.window = w;
          localStorage.setItem("gpumon.window", w);
          buildWinSwitch();
          render();
        },
      }, [w]);
      box.appendChild(b);
    });
  }

  function buildThemeSwitch() {
    const box = document.getElementById("themeSwitch");
    if (!box) return;
    box.innerHTML = "";
    [["dark", "moon.svg"], ["light", "sun.svg"]].forEach(([key, icon]) => {
      const b = UI.el("button", {
        class: key === state.theme ? "active" : "",
        title: I18n.t('theme_' + key),
        onclick: () => setTheme(key),
      }, []);
      const img = document.createElement("img");
      img.src = "icons/" + icon;
      img.className = "topbar-icon";
      b.appendChild(img);
      box.appendChild(b);
    });
  }

  async function pollHealth() {
    const dot = document.getElementById("hdot");
    const txt = document.getElementById("htext");
    const generation = renderGeneration;
    const view = parseRoute().view;
    if (view === "home" || view === "pai") {
      const zh = I18n.getLocale() === "zh";
      const pai = (state.sourceHealth || {}).pai;
      const tone = !pai ? "" : pai.state === "ok" ? "green" : ["error", "disabled"].includes(pai.state) ? "red" : "yellow";
      const label = !pai ? (zh ? "读取中…" : "Loading…")
        : { ok: zh ? "正常" : "healthy", partial: zh ? "部分缺失" : "partial", stale: zh ? "数据陈旧" : "stale",
          error: zh ? "采集失败" : "failed", waiting: zh ? "等待采集" : "waiting", disabled: zh ? "未启用" : "disabled" }[pai.state] || pai.state;
      dot.className = "dot " + tone;
      txt.replaceChildren(...[
        UI.el("span", { class: "health-count" }, ["PAI " + label]),
        pai && pai.ts ? UI.el("span", { class: "health-age" }, [UI.ago(Math.floor(pai.ts))]) : null].filter(Boolean));
      dot.parentElement.title = zh ? "PAI 采集状态；裸金属状态见裸金属页面" : "PAI collection status; bare-metal status is on its own page";
      return;
    }
    try {
      const [st, hl] = await Promise.all([API.collectorStatus(), API.health()]);
      if (generation !== renderGeneration) return;
      const activeHosts = st.hosts.filter((h) => h.status !== "planned");
      const online = activeHosts.filter((h) => h.online).length;
      const total = activeHosts.length;
      const age = hl.last_sample_age_s;
      let cls = "green";
      if (total > 0 && activeHosts.every((h) => UI.hostHealth(h) === "offline")) cls = "red";
      else if (online < total || age == null || activeHosts.some((h) => UI.hostHealth(h) !== "online") || age > 90) cls = "yellow";
      dot.className = "dot " + cls;
      txt.replaceChildren(
        UI.el("span", { class: "health-count" }, [I18n.t('health_online_count', {online, total})]),
        UI.el("span", { class: "health-age" }, [I18n.t('health_data_age', {time: UI.ago(hl.last_sample_ts)})]));
      dot.parentElement.title = activeHosts.map((h) =>
        `${h.display_name}: ${UI.hostStatus(h)} ${I18n.t('health_cards', {seen: h.gpus_seen ?? 0, expected: h.gpus_expected})}` +
        (h.last_error ? " (" + h.last_error + ")" : "")).join("\n");
    } catch (e) {
      if (generation !== renderGeneration) return;
      dot.className = "dot red"; txt.textContent = I18n.t('service_unreachable');
      PageRecovery.show();
    }
  }

  async function init() {
    I18n.init();
    state.theme = localStorage.getItem("gpumon.theme") === "light" ? "light" : "dark";
    applyTheme();
    const [meta, pai] = await Promise.allSettled([API.meta(), API.paiStatus()]);
    if (meta.status === "rejected") PageRecovery.show();
    state.meta = meta.status === "fulfilled" ? meta.value : {windows: ["1h", "24h", "7d"], capacity_groups: []};
    // 只有接口明确返回 enabled=true，或返回 503（已启用但快照暂不可用）时才显示 PAI；其余一律按未启用处理。
    state.paiEnabled = pai.status === "fulfilled" ? pai.value.enabled === true : pai.reason?.status === 503;
    state.baremetalNotice = pai.status === "fulfilled" ? pai.value.baremetal_notice : "";
    // 把"算力域 → 色带"映射交给 Palette，之后所有身份色都按 inventory 配置走
    UI.Palette.setGroups(state.meta.capacity_groups);
    // 恢复保存的时间窗，默认 24h
    const savedWindow = localStorage.getItem("gpumon.window");
    if (savedWindow && state.meta.windows.includes(savedWindow)) {
      state.window = savedWindow;
    } else if (!state.meta.windows.includes(state.window)) {
      state.window = state.meta.windows[1] || state.meta.windows[0];
    }
    buildLangSwitch();
    buildThemeSwitch();
    buildWinSwitch();
    updateDemoBanner();
    // 设置 navRank 文字
    document.getElementById("navRankText").textContent = I18n.t('user_ranking');
    window.addEventListener("hashchange", render);
    window.addEventListener("resize", () => charts.forEach((c) => { try { c.resize(); } catch (e) {} }));
    document.getElementById("title").onclick = () => go("/");
    // 在排行页再点一次返回所在模块的总览，裸金属与 PAI 行为一致。
    document.getElementById("navRank").onclick = () => {
      const r = parseRoute();
      if (r.view === "pai") go(r.params.tab === "ranking" ? "/pai" : "/pai/ranking");
      else go(r.view === "ranking" ? overviewPath() : "/ranking");
    };
    document.querySelector(".health").onclick = () => {
      const view = parseRoute().view;
      if (view !== "home" && view !== "pai") return go(overviewPath());
      const sources = document.getElementById("paiSources");
      if (sources) { sources.open = true; sources.scrollIntoView({ behavior: "smooth", block: "start" }); } else go("/pai");
    };
    await render();
    pollHealth();
    setInterval(pollHealth, 15000);
  }

  return { state, go, overviewPath, crumb, render, setSourceHealth, onResize, buildLangSwitch, buildThemeSwitch, buildWinSwitch, updateDemoBanner, init };
})();

document.addEventListener("DOMContentLoaded", () => { GM.init().catch(PageRecovery.show); });
