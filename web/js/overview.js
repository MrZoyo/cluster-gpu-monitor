// 总览视图：算力域 → 集群 → 设备，默认展开，保留热力、排行和多窗口对比。
window.Views = window.Views || {};
window.Views.overview = (function () {
  const { el, gpuCard, gpuPlaceholder, utilCell, fmtPct, fmtGB, Palette, ago, badgeRow } = UI;

  function statsForClusters(clusters) {
    const hosts = clusters.flatMap((c) => c.hosts || []);
    const gpus = hosts.flatMap((h) => h.gpus || []);
    const expected = hosts.reduce((a, h) => a + (h.gpu_count || 0), 0);
    const activeHosts = hosts.filter((h) => h.status !== "planned");
    // 在用数与"当前均值"按近期(10min)平滑值算，与卡片大字/底色及后端 cards_busy 一致。
    const busy = gpus.filter((g) => g.util_recent != null && g.util_recent >= (GM.state.meta.busy_threshold || 10)).length;
    const utilVals = gpus.map((g) => g.util_recent).filter((v) => v != null);
    return {
      clusters: clusters.length,
      hosts: hosts.length,
      activeHosts: activeHosts.length,
      plannedHosts: hosts.length - activeHosts.length,
      expected,
      discovered: gpus.length,
      busy,
      avg: utilVals.length ? utilVals.reduce((a, v) => a + v, 0) / utilVals.length : null,
    };
  }

  function kpis(ov) {
    const s = ov.summary;
    const cardsExpected = s.cards_expected || s.cards_total;
    const items = [
      { k: "瞬时利用率", v: fmtPct(s.util_now_avg) },
      { k: `${s.window} 平均`, v: s.util_avg == null ? "积累中" : fmtPct(s.util_avg) },
      { k: "GPU 在用 / 已发现", v: `${s.cards_busy} / ${s.cards_total}`, hint: `接入覆盖 ${s.cards_total} / ${cardsExpected}` },
      { k: "在线主机", v: `${s.hosts_online} / ${s.hosts_total}` },
    ];
    if (s.hosts_planned > 0) items.push({ k: "待接入主机", v: s.hosts_planned });
    return el("div", { class: "kpis" },
      items.map(({ k, v, hint }) => el("div", { class: "kpi" }, [
        el("div", { class: "v" }, [String(v)]),
        el("div", { class: "k" }, [k]),
        hint ? el("div", { class: "hint" }, [hint]) : null,
      ])));
  }

  function legend(ov) {
    const hasPlanned = ov.clusters.some((c) => c.status === "planned" ||
      c.hosts.some((h) => h.status === "planned"));
    // 利用率是 0→100 的连续量：用按范围比例分段的刻度尺表达"越往右越忙"。
    // 每段颜色取自 utilColor（档位内代表值），保证图例与卡片一致，也随主题联动。
    const bands = [
      { t: "空闲", v: 5, from: 0, to: 10 },
      { t: "在用", v: 20, from: 10, to: 40 },
      { t: "偏忙", v: 50, from: 40, to: 70 },
      { t: "繁忙", v: 80, from: 70, to: 90 },
      { t: "满载", v: 95, from: 90, to: 100 },
    ];
    const bar = el("div", { class: "util-scale-bar" },
      bands.map((b) => {
        const { bg, dark } = UI.utilColor(b.v);
        return el("div", {
          class: "seg", style: `flex:${b.to - b.from};background:${bg};color:${dark ? "#0a0d14" : "#fff"}`,
          title: `${b.t} ${b.from}–${b.to}%`,
        }, [b.t]);
      }));
    const ticks = el("div", { class: "util-scale-ticks" },
      [0, 10, 40, 70, 90, 100].map((v) => el("span", { style: `left:${v}%` }, [String(v)])));
    const scale = el("div", { class: "util-scale" }, [bar, ticks]);
    const children = [el("span", { class: "legend-cap" }, ["利用率 %"]), scale];
    if (hasPlanned) {
      children.push(el("span", { class: "planned-legend" },
        [el("span", { class: "sw planned-sw" }), "待接入"]));
    }
    return el("div", { class: "legend util-legend" }, children);
  }

  function groupClusters(ov) {
    const groups = (ov.capacity_groups || GM.state.meta.capacity_groups || [])
      .map((g) => ({ ...g, clusters: [] }));
    const byKey = {};
    groups.forEach((g) => { byKey[g.key] = g; });
    ov.clusters.forEach((c) => {
      const key = c.capacity_group || "";
      if (!byKey[key]) {
        // 防御：后端 capacity_groups 里没有这个域（正常不该发生）。名字兜底不留空白标题。
        byKey[key] = { key, name: c.capacity_group_name || key || "未分组",
          sort_order: 999, clusters: [] };
        groups.push(byKey[key]);
      }
      byKey[key].clusters.push(c);
    });
    return groups
      .filter((g) => g.clusters.length)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  function capacityNav(groups) {
    return el("div", { class: "capacity-tabs" }, groups.map((g) => {
      const st = statsForClusters(g.clusters);
      return el("button", { onclick: () => document.getElementById("cap-" + g.key)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, [
        el("span", { class: "tab-name" }, [g.name]),
        el("span", { class: "tab-meta" }, [`${st.clusters} 集群 · ${st.expected} 卡`]),
      ]);
    }));
  }

  function alertPanel(ov) {
    const activeHosts = ov.clusters.flatMap((c) => c.hosts.map((h) => ({ ...h, cluster: c.name })))
      .filter((h) => h.status !== "planned");
    const offline = activeHosts.filter((h) => !h.online);
    const hot = ov.clusters.flatMap((c) => c.hosts.flatMap((h) => (h.gpus || []).map((g) => ({ g, h, c }))))
      .filter((x) => x.g.util_recent != null && x.g.util_recent >= 90)
      .sort((a, b) => b.g.util_recent - a.g.util_recent);
    const planned = ov.clusters.filter((c) => c.status === "planned" || c.hosts.some((h) => h.status === "planned"));
    const rows = [];
    rows.push(el("div", { class: offline.length ? "alert bad" : "alert ok" },
      [el("b", {}, [String(offline.length)]), el("span", {}, ["离线已接入主机"])]));
    rows.push(el("div", { class: hot.length ? "alert hot" : "alert ok" },
      [el("b", {}, [String(hot.length)]), el("span", {}, ["满载 GPU"])]));
    if (planned.length) {
      rows.push(el("div", { class: "alert planned-alert" },
        [el("b", {}, [String(planned.length)]), el("span", {}, ["待接入集群"])]));
    }
    return el("div", { class: "ops-strip", style: `--alert-count:${rows.length}` }, rows);
  }

  function hotGpuPanel(ov) {
    const items = ov.clusters.flatMap((c) => c.hosts.flatMap((h) =>
      (h.gpus || []).map((g) => ({ c, h, g }))))
      .filter((x) => x.g.util_recent != null)
      .sort((a, b) => b.g.util_recent - a.g.util_recent)
      .slice(0, 8);
    const rows = items.length ? items.map((x) => el("button", {
      onclick: () => GM.go(`/gpu/${x.g.gpu_id}`),
      title: `${x.c.name} / ${x.h.display_name} / GPU #${x.g.index}`,
    }, [
      el("span", { class: "hot-gpu-main" }, [`${x.h.display_name} #${x.g.index}`]),
      el("span", { class: "hot-gpu-util" }, [fmtPct(x.g.util_recent)]),
    ])) : [el("div", { class: "note" }, ["暂无实时 GPU 数据"])];
    return el("div", { class: "hot-gpus" }, rows);
  }

  function capacitySection(group, idx) {
    const st = statsForClusters(group.clusters);
    const nC = group.clusters.length;
    const section = el("section", { class: "capacity-section", id: "cap-" + group.key, style: `--caccent:${Palette.groupAccent(group.key)}` });
    section.appendChild(el("div", { class: "capacity-head" }, [
      el("div", {}, [
        el("div", { class: "eyebrow" }, ["CAPACITY DOMAIN"]),
        el("h2", {}, [group.name]),
      ]),
      el("div", { class: "capacity-metrics" }, [
        metric("集群", st.clusters),
        metric("主机", `${st.activeHosts}/${st.hosts}`),
        metric("GPU", `${st.discovered}/${st.expected}`),
        metric("当前均值", fmtPct(st.avg)),
      ]),
    ]));
    if (group.description) section.appendChild(el("div", { class: "capacity-note" }, [group.description]));
    section.appendChild(el("div", { class: "cluster-tabs" },
      group.clusters.map((c, i) => clusterTab(c, i, group.key, nC))));
    group.clusters.forEach((c, i) => section.appendChild(clusterBlock(c, i, group.key, nC)));
    return section;
  }

  function metric(label, value) {
    return el("div", { class: "mini-metric" }, [
      el("span", {}, [label]),
      el("b", {}, [String(value)]),
    ]);
  }

  function clusterTab(c, idx, groupKey, nC) {
    const st = statsForClusters([c]);
    const col = Palette.clusterColor(groupKey || "", idx, nC || 1);
    return el("button", { onclick: () => document.getElementById("cluster-" + c.key)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, [
      el("span", { class: "cluster-dot", style: `background:${col}` }),
      el("span", {}, [c.name]),
      el("small", {}, [`${st.hosts} 机 / ${st.expected} 卡`]),
    ]);
  }

  function clusterBlock(c, idx, groupKey, nC) {
    const st = statsForClusters([c]);
    const col = Palette.clusterColor(groupKey || "", idx, nC || 1);
    const details = el("details", { class: `cluster-block ${c.status === "planned" ? "planned-block" : ""}`, id: "cluster-" + c.key, open: "" });
    // 集群名做成真链接（hash 路由，href 原生可用 → 悬停看得到目标、支持 ctrl+click 开新标签）。
    // 点它进集群详情页，而不是展开/收起——展开归右侧的 ▾ 与 summary 空白区。
    // 必须 preventDefault：summary 的默认行为就是 toggle，不拦就会"既跳转又折叠"。
    const nameLink = el("a", {
      class: "cluster-title-name",
      href: `#/cluster/${encodeURIComponent(c.key)}`,
      title: `查看 ${c.name} 详情页（各主机卡阵 · 利用率时序 · 使用人 Top）`,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // 让浏览器原生开新标签
        // 链接在 <summary> 内，点击会冒泡触发 details 的默认 toggle。
        // 两个都要拦：preventDefault 挡 summary 的 toggle，stopPropagation 防冒泡。
        e.preventDefault();
        e.stopPropagation();
        GM.go(`/cluster/${c.key}`);
      },
    }, [c.name]);
    const summary = el("summary", { style: `--caccent:${col}` }, [
      el("div", { class: "cluster-title" }, [
        el("span", { class: "cluster-index" }, [String(idx + 1).padStart(2, "0")]),
        nameLink,
        badgeRow(c),
        c.status === "planned" ? el("span", { class: "badge planned-badge" }, ["待接入"]) : null,
      ].filter(Boolean)),
      el("div", { class: "cluster-stats" }, [
        metric("主机", st.hosts),
        metric("GPU", `${st.discovered}/${st.expected}`),
        metric("在用", st.busy),
        metric("均值", fmtPct(st.avg)),
        // 折叠指示器：明确"这里是展开/收起"，与左侧"进详情页"的集群名分工
        el("span", { class: "cluster-toggle", title: "展开 / 收起卡片" }, []),
      ]),
    ]);
    details.appendChild(summary);
    if (c.note) details.appendChild(el("div", { class: "cluster-note" }, [c.note]));
    if (!c.hosts.length) {
      details.appendChild(el("div", { class: "empty-state" }, ["暂无设备"]));
    } else {
      c.hosts.forEach((h) => details.appendChild(hostRow(h, c)));
    }
    return details;
  }

  function hostRow(h, c) {
    const sys = h.system;
    const sysText = h.status === "planned"
      ? `${(h.meta && h.meta.gpu_model) || "GPU"} · 规划 ${h.gpu_count} 卡`
      : sys
        ? `CPU ${fmtPct(sys.cpu_util_pct)} · load ${sys.load1 ?? "-"} · 内存 ${fmtGB(sys.mem_used_mib)}/${fmtGB(sys.mem_total_mib)}`
        : "无系统数据";
    const statusLabel = h.status === "planned" ? "待接入" : (h.online ? "在线" : `离线 ${h.consec_fail || 0} 次`);
    const offline = h.status !== "planned" && !h.online;
    const cards = (h.gpus && h.gpus.length)
      ? h.gpus.map((g) => gpuCard(g, { offline, onClick: (x) => GM.go(`/gpu/${x.gpu_id}`) }))
      : Array.from({ length: h.gpu_count || 0 }, (_, i) => gpuPlaceholder(i, h.display_name));
    const row = el("div", { class: `host-row ${h.status === "planned" ? "planned-host" : ""}` }, [
      el("div", { class: "host-name", onclick: () => GM.go(`/host/${h.key}`) }, [
        el("div", { class: "hn" }, [h.display_name]),
        el("div", { class: "hs" }, [`${statusLabel} · ${h.gpus_seen ?? 0}/${h.gpu_count} 卡`]),
      ]),
      el("div", { class: "host-sys" }, [sysText]),
      el("div", { class: "cards" }, cards),
    ]);
    if (h.last_error && h.status !== "planned") row.title = `${c.name}: ${h.last_error}`;
    if (h.note && h.status === "planned") row.title = h.note;
    return row;
  }

  function compareTable(ov, multi) {
    const wins = GM.state.meta.windows;
    const byWin = {};
    wins.forEach((w) => {
      byWin[w] = {};
      (multi.windows[w] || []).forEach((it) => { byWin[w][it.host] = it; });
    });
    const head = el("tr", {}, [el("th", {}, ["主机"]), el("th", {}, ["集群"]), el("th", {}, ["状态"]),
      ...wins.map((w) => el("th", { class: "num" }, [w + " 均值"]))]);
    const rows = [head];
    ov.clusters.forEach((c) => c.hosts.forEach((h) => {
      const tds = [
        el("td", {}, [el("a", { onclick: () => GM.go(`/host/${h.key}`), href: "javascript:;" }, [h.display_name])]),
        el("td", {}, [c.name]),
        el("td", {}, [h.status === "planned" ? "待接入" : (h.online ? "在线" : "离线")]),
      ];
      wins.forEach((w) => {
        const it = byWin[w][h.key];
        tds.push(utilCell(it ? it.avg : null, it ? it.coverage : null));
      });
      rows.push(el("tr", {}, tds));
    }));
    return el("div", { class: "panel compare-panel" }, [
      el("h3", {}, ["各主机平均利用率 · 多时间窗对比"]),
      el("table", {}, [el("tbody", {}, rows)]),
    ]);
  }

  async function render(root) {
    const w = GM.state.window;
    GM.crumb("总览");
    const [ov, multi] = await Promise.all([API.overview(w), API.avgMulti("host", "util_gpu")]);
    const groups = groupClusters(ov);
    root.innerHTML = "";
    root.appendChild(el("section", { class: "command-panel" }, [
      el("div", { class: "command-copy" }, [
        el("div", { class: "eyebrow" }, ["GPU FLEET CONTROL"]),
        el("h1", {}, ["算力监控总览"]),
        el("div", { class: "note" }, [`更新于 ${ago(ov.now)} · 每 ${GM.state.meta.poll_interval_s || 30} 秒刷新`]),
      ]),
      el("div", {}, [alertPanel(ov), hotGpuPanel(ov)]),
    ]));
    root.appendChild(kpis(ov));
    root.appendChild(legend(ov));
    root.appendChild(capacityNav(groups));
    groups.forEach((g, i) => root.appendChild(capacitySection(g, i)));
    root.appendChild(compareTable(ov, multi));
  }

  return { render };
})();
