// 单机视图：系统指标 + 8 卡网格（瞬时/均值/使用人）+ 多卡利用率时序 + 该机使用人。
window.Views = window.Views || {};
window.Views.host = (function () {
  const { el, gpuCard, gpuPlaceholder, fmtPct, fmtGB, lineChart, Palette } = UI;

  async function render(root, params) {
    const w = GM.state.window;
    const ov = await API.overview(w);
    let host = null, cluster = null;
    for (const c of ov.clusters) {
      const h = c.hosts.find((x) => x.key === params.key);
      if (h) { host = h; cluster = c; break; }
    }
    if (!host) { root.innerHTML = "<p class='note'>未找到主机</p>"; return; }
    GM.crumb(`总览 › ${cluster.name} › ${host.display_name}`);
    root.innerHTML = "";
    root.appendChild(el("span", { class: "back", onclick: () => GM.go(`/cluster/${cluster.key}`) }, ["‹ 返回 " + cluster.name]));

    // 系统指标 KPI
    const sys = host.system || {};
    const kpi = [
      ["CPU 利用率", fmtPct(sys.cpu_util_pct)],
      ["load1 / 核数", `${sys.load1 ?? "—"} / ${sys.ncpu ?? "—"}`],
      ["内存", `${fmtGB(sys.mem_used_mib)} / ${fmtGB(sys.mem_total_mib)}`],
      ["状态", host.status === "planned" ? "待接入" : (host.online ? "在线" : `离线（${host.consec_fail}次失败）`)],
    ];
    root.appendChild(el("div", { class: "kpis" }, kpi.map(([k, v]) =>
      el("div", { class: "kpi" }, [el("div", { class: "v" }, [String(v)]), el("div", { class: "k" }, [k])]))));
    if (host.last_error) root.appendChild(el("div", { class: "note" }, ["最近错误：" + host.last_error]));

    // 8 卡网格
    const gridOffline = host.status !== "planned" && !host.online;
    const grid = el("div", { class: "panel" }, [el("h3", {}, ["GPU（点击看单卡趋势）"]),
      el("div", { class: "cards" }, host.gpus.length
        ? host.gpus.map((g) => gpuCard(g, { offline: gridOffline, onClick: (x) => GM.go(`/gpu/${x.gpu_id}`) }))
        : Array.from({ length: host.gpu_count || 0 }, (_, i) => gpuPlaceholder(i, host.display_name)))]);
    root.appendChild(grid);

    if (host.status === "planned" || !host.gpus.length) {
      root.appendChild(el("div", { class: "panel" }, [
        el("h3", {}, ["接入状态"]),
        el("div", { class: "note" }, [host.note || "该设备已预留，待 SSH/root 权限就绪后开始采集。"]),
      ]));
      return;
    }

    // 多卡利用率时序（每卡一条线）
    const chartPanel = el("div", { class: "panel" }, [el("h3", {}, [`各卡 GPU 利用率 · 近 ${w}`])]);
    const dom = el("div", { class: "chart" });
    chartPanel.appendChild(dom); root.appendChild(chartPanel);
    const seriesData = await Promise.all(host.gpus.map((g) =>
      API.series("gpu", g.gpu_id, "util_gpu", w).then((s) => ({ name: "#" + g.index, points: s.points }))));
    // 同机多卡：唯一目标是把每条线区分开 → 色相分散、避开满载红（非分组相近色）
    const palette = Palette.seriesColors(seriesData.length);
    seriesData.forEach((s, i) => (s.color = palette[i]));
    const chart = lineChart(dom, seriesData, { max: 100 });
    GM.onResize(chart);

    // 当前使用人（该机）
    const users = [];
    host.gpus.forEach((g) => (g.users || []).forEach((u) =>
      users.push({ gpu: g.index, username: u.username, comm: u.comm, mem: u.mem_used_mib })));
    const rows = [el("tr", {}, [el("th", {}, ["卡"]), el("th", {}, ["使用人"]), el("th", {}, ["进程"]), el("th", {}, ["显存"])])];
    users.sort((a, b) => (b.mem || 0) - (a.mem || 0)).forEach((u) =>
      rows.push(el("tr", {}, [el("td", {}, ["#" + u.gpu]), el("td", {}, [u.username || "?"]),
        el("td", {}, [u.comm || "—"]), el("td", { class: "num" }, [fmtGB(u.mem)])])));
    root.appendChild(el("div", { class: "panel" }, [el("h3", {}, ["当前使用人"]),
      users.length ? el("table", {}, [el("tbody", {}, rows)]) : el("div", { class: "note" }, ["当前无 GPU 进程"])]));
  }

  return { render };
})();
