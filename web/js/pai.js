// PAI 平台视图：只读本地快照；云凭证与云 API 请求从不进入浏览器。
// 口径约束：分配卡数、任务申请卡数、计算利用率、显存百分比分开展示；缺测保持未知，不计为 0%。
window.Views = window.Views || {};
window.PaiUI = (() => {
  const el = UI.el;
  const t = (zh, en) => (I18n.getLocale() === "zh" ? zh : en);
  // 已分配但计算 <5%：与裸金属"空闲"阈值一致，按近 10 分钟均值判断（至少 5 个分钟点），避免单分钟抖动。
  const LOW = 5;
  const RECENT_MIN_POINTS = 5;
  const isLow = (m) => !!(m && m.fresh && m.recent_n >= RECENT_MIN_POINTS && m.recent_mean != null && m.recent_mean < LOW);
  // 跨 120 秒自动刷新保留的交互状态，避免刷新后筛选、排序、展开被重置。
  const ui = { type: "all", q: "", sort: "gpu", desc: true, nodes: "all", sourcesOpen: false };

  const num = (v) => {
    const n = Number(v);
    return v == null || v === "" || !Number.isFinite(n) ? null : n;
  };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (v) => (v == null ? "—" : Math.round(v) + "%");
  const pct1 = (v) => (v == null ? "—" : Number(v).toFixed(1) + "%");
  const gpus = (v) => {
    const n = num(v);
    return n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  // 快照时间是浮点秒；UI.ago 按整数秒格式化。
  const ago = (ts) => UI.ago(ts == null ? ts : Math.floor(ts));
  const clock = (ts) => (ts == null ? t("未知", "unknown") : new Date(ts * 1000).toLocaleString());
  const href = (...parts) => "#/pai/" + parts.map((p) => encodeURIComponent(p)).join("/");
  const link = (text, url, cls) => el("a", { href: url, class: cls || null }, [text || "—"]);
  const note = (text, cls) => el("p", { class: "note" + (cls ? " " + cls : "") }, [text]);
  const plural = (n, zh, en) => t(`${n} ${zh}`, `${n} ${en}${n === 1 ? "" : "s"}`);
  const dur = (sec) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return t(`${d} 天 ${h % 24} 小时`, `${d}d ${h % 24}h`);
    if (h) return t(`${h} 小时 ${m % 60} 分`, `${h}h ${m % 60}m`);
    return t(`${m} 分钟`, `${m}m`);
  };
  const LONG_WAIT_S = 30 * 60;

  const STATE = {
    ok: ["正常", "Healthy", "ok"], partial: ["部分缺失", "Partial", "warn"], stale: ["数据陈旧", "Stale", "warn"],
    error: ["采集失败", "Failed", "bad"], no_data: ["源无指标", "No metrics", "muted"],
    disabled: ["未启用", "Disabled", "muted"], waiting: ["等待首轮采集", "Waiting", "muted"],
    unknown: ["未知", "Unknown", "muted"], Running: ["运行中", "Running", "ok"], Ready: ["就绪", "Ready", "ok"],
    SchedulingDisabled: ["禁止调度", "Cordoned", "warn"], NotReady: ["未就绪", "Not ready", "bad"],
    Queuing: ["排队中", "Queued", "warn"], Enqueued: ["排队中", "Queued", "warn"], Pending: ["待调度", "Pending", "warn"],
    // 管理资源配额文档把禁止调度中的该类情形称为“自愈中”。
    Recovering: ["自愈中（Recovering）", "Self-healing (Recovering)", "bad"],
  };
  const stateTone = (s) => (STATE[s] || [])[2] || "muted";
  const stateText = (s) => (STATE[s] ? t(STATE[s][0], STATE[s][1]) : s || t("未知", "Unknown"));
  const chip = (s) => el("span", { class: "pai-chip " + stateTone(s) }, [stateText(s)]);
  const typeChip = (type) => el("span", { class: "pai-chip type-" + (type === "dlc" ? "dlc" : "dsw") },
    [String(type || "?").toUpperCase()]);

  // 阿里云官方文档：页面上的 PAI 概念直接链接原文；英文界面用国际站的同名页面。
  const DOCS = {
    quota: ["resource-quota/", "资源配额（Quota）", "Resource quotas"],
    manageQuota: ["manage-resource-quotas", "管理资源配额", "Manage resource quotas"],
    idle: ["use-idle-resources-in-dlc-jobs", "使用闲时资源", "Idle-time resources"],
    preempt: ["resource-quota-quota-preemption-policy", "抢占策略", "Preemption policy"],
    schedule: ["scheduling-policies", "调度策略", "Scheduling policies"],
    dlc: ["create-a-training-task", "创建训练任务（DLC）", "Create a training job (DLC)"],
    dsw: ["create-and-manage-dsw-instances", "创建 DSW 实例", "Create a DSW instance"],
    selfHeal: ["configure-lingjun-node-self-healing-notification", "节点自愈", "Node self-healing"],
  };
  const docUrl = (key) => (I18n.getLocale() === "zh" ? "https://help.aliyun.com/zh/pai/" : "https://www.alibabacloud.com/help/en/pai/") + DOCS[key][0];
  function doc(key, label) {
    return el("a", { class: "pai-doc", href: docUrl(key), target: "_blank", rel: "noopener noreferrer",
      title: t("阿里云文档：", "Alibaba Cloud docs: ") + t(DOCS[key][1], DOCS[key][2]) }, [label || t(DOCS[key][1], DOCS[key][2]), " ↗"]);
  }
  // DLC 提交策略（官方枚举）：与实际是否落在闲时资源上是两回事。
  const STRATEGY = {
    ForceQuotaOverSold: ["只接受闲时资源", "Idle resources only"],
    AcceptQuotaOverSold: ["可接受闲时资源", "Accepts idle resources"],
    ForbiddenQuotaOverSold: ["不接受闲时资源", "No idle resources"],
  };
  const strategyText = (v) => (STRATEGY[v] ? t(...STRATEGY[v]) : v || t("未知", "Unknown"));
  const specText = (sp) => `${sp.type || "Pod"} ${gpus(sp.pods)}×` + [`${gpus(sp.gpu)} GPU`,
    sp.cpu != null ? t(`${gpus(sp.cpu)} 核`, `${gpus(sp.cpu)} cores`) : null, sp.mem_gib != null ? `${gpus(sp.mem_gib)} GiB` : null].filter(Boolean).join(" · ");
  // 只翻译已确认含义的调度器代码；原始 Code / CodeType / Reason 始终保留。
  const QUEUE_CODES = {
    CheckSelfQuotaFailed: ["配额资源检查未通过（可能为资源限制或碎片）", "Quota check failed (resource limits or fragmentation)"],
    QuotaCheckFail: ["配额资源检查未通过（可能为资源限制或碎片）", "Quota check failed (resource limits or fragmentation)"],
    roleMaximumResource: ["超过角色配置的资源上限", "Exceeds the role's configured resource limit"],
  };
  // 控制台称“闲时资源”，接口字段为 OverSold（UseOversoldResource / OversoldType）。
  const OVERSOLD_TIP = () => t("闲时资源（配额外）：任务使用租户内其他配额此刻空闲的同规格资源，不计入配额用量、不受配额总量限制，节点名不公开、具体位置未核实；资源方需要时任务会被回收。接口字段：UseOversoldResource。",
    "Idle-time resources (outside the quota): idle same-spec capacity of other quotas in the tenant. Not counted in or limited by quota usage; node names hidden and location unverified; reclaimed when the owner needs it. API field: UseOversoldResource.");
  const oversoldChip = (text) => el("span", { class: "pai-chip oversold", title: OVERSOLD_TIP() }, [text || t("闲时", "Idle-time")]);

  // 复用裸金属 .cellbar：计算用利用率热力色，显存固定用紫色（避免与"满载红"语义混淆）。
  function bar(v, opts) {
    opts = opts || {};
    if (v == null) return el("span", { class: "pai-dash", title: opts.title || t("无近期指标", "No recent metric") }, ["—"]);
    const color = opts.memory ? "var(--mem)" : UI.utilColor(v).bg;
    const w = Math.max(0, Math.min(100, Math.round(v)));
    const title = (opts.title || "") + (opts.stale ? (opts.title ? "\n" : "") + t("含陈旧值：最近一次成功采集的结果", "Includes stale values from the last successful fetch") : "");
    return el("span", { class: "cellbar" + (opts.stale ? " stale" : ""), style: `--util-color:${color};--util-pct:${w}%`, title }, [pct(v)]);
  }

  function commonPrefix(names) {
    if (names.length < 2) return "";
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    return p;
  }

  // 派生当前视图模型：只基于快照中已有字段，不推断历史归属。
  function prepare(d) {
    const names = d.nodes.map((n) => n.NodeName);
    const prefix = commonPrefix(names);
    const short = (name) => (prefix.length >= 6 && name.length - prefix.length >= 4 ? "…" + name.slice(prefix.length) : name);
    const quotas = Object.fromEntries((d.quotas || []).map((q) => [q.quota_id, q]));
    const maxNodeGpu = Math.max(0, ...d.nodes.map((n) => num(n.GPU) || 0));
    const quotaOrder = (id) => { const i = (d.quotas || []).findIndex((q) => q.quota_id === id); return i < 0 ? 999 : i; };
    const cards = [];
    d.nodes.forEach((n) => {
      n.short = short(n.NodeName);
      // 节点绑定的子配额（根配额对所有节点都成立，不重复显示）；健康度 10000 = 100%。
      n.quotaIds = (n.bound_quotas || []).filter((id) => id !== d.quota_id);
      n.quotaNames = n.quotaIds.map((id) => quotas[id]?.quota_name || id);
      n.healthPct = num(n.health_rate) == null ? null : num(n.health_rate) / 100;
      n.unhealthy = !!n.ReasonCode || (n.healthPct != null && n.healthPct < 100);
      const assigned = n.cards.filter((c) => c.assignments.length).length;
      const requested = num(n.RequestGPU);
      // 仅当本节点 Pod 映射新鲜、且节点请求量不超过已关联卡数时，未关联的卡才判定为空闲；否则保持未知。
      const canBeFree = n.mapping_state === "ok" && requested != null && requested <= assigned;
      n.cards.forEach((c) => {
        c.nodeName = n.NodeName;
        c.state = c.assignments.length ? (c.compute ? "measured" : "assigned") : (canBeFree ? "free" : "unknown");
        c.stale = !!(c.compute && !c.compute.fresh) || c.assignments.some((a) => !a.fresh);
        c.low = c.state === "measured" && isLow({ fresh: c.compute.fresh, recent_mean: c.compute.recent, recent_n: c.compute.recent_n });
        cards.push(c);
      });
      n.assigned = assigned;
      n.free = n.cards.filter((c) => c.state === "free").length;
      n.owners = [...new Set(n.cards.flatMap((c) => c.assignments.map((a) => a.owner_name || "—")))];
      n.workloadIds = [...new Set(n.cards.flatMap((c) => c.assignments.map((a) => a.workload_id)))];
    });
    d.nodes.sort((a, b) => quotaOrder(a.quotaIds[0]) - quotaOrder(b.quotaIds[0]) || a.NodeName.localeCompare(b.NodeName));
    d.workloads.forEach((w) => {
      w.quota = quotas[w.QuotaId]?.quota_name || w.QuotaId || "—";
      // 主机 CPU / 内存是 Pod 级指标（GPU 维度为空），与单卡指标分开。
      w.hostMetrics = w.metrics.filter((m) => m.metric === "cpu" || m.metric === "ram");
      w.metrics = w.metrics.filter((m) => m.metric === "compute" || m.metric === "memory");
      const hostLatest = (metric) => w.hostMetrics.filter((m) => m.metric === metric).map((m) => m.value);
      w.cpu = mean(hostLatest("cpu"));
      w.ram = mean(hostLatest("ram"));
      w.hostStale = w.hostMetrics.some((m) => !m.fresh);
      w.strategy = w.job?.oversold_type || null;
      w.specs = w.job?.specs || [];
      // 旧快照没有这些字段时保持未知（false），不臆测。
      // 排队态既看调度标志也看状态：曾出现 Status=Dequeued 但 IsScheduled=false、WorkloadStatus=Pending 的样本。
      w.queued = w.scheduled === false || ["Queuing", "Enqueued", "Pending"].includes(w.WorkloadStatus);
      // UseOversoldResource 只对已调度任务表示“实际使用闲时资源”；排队任务尚无占用。
      w.oversold = w.oversold === true && !w.queued;
      w.queuedFor = w.queued && w.enqueued_at ? Math.max(0, (d.now || Date.now() / 1000) - w.enqueued_at) : null;
      w.longWait = w.queuedFor != null && w.queuedFor >= LONG_WAIT_S;
      // 排队原因：平台给出的原因原样展示；页面只补两条能由快照直接证明的硬性规则，不做推测。
      w.blockers = [];
      if (w.queued) {
        const req = num(w.requested_gpu), cap = num(quotas[w.QuotaId]?.gpu_capacity);
        const forbidden = w.strategy === "ForbiddenQuotaOverSold", known = !!STRATEGY[w.strategy];
        if (w.queue_reason || w.queue_code) {
          const known = QUEUE_CODES[w.queue_code];
          w.blockers.push({ kind: "platform", level: "info", text: known ? t(...known) : (w.queue_reason || w.queue_code), raw: [w.queue_code, w.queue_reason].filter(Boolean).join(" · ") });
        }
        // 配额总量：只有“不接受闲时资源”时才能确定当前配置放不下；策略未知时只是风险。
        if (req != null && cap != null && req > cap) w.blockers.push(forbidden
          ? { kind: "quota", level: "hard", text: t(`申请 ${gpus(req)} 卡 > 配额 ${w.quota} 容量 ${gpus(cap)} 卡，且提交时选了“不接受闲时资源”：当前配置放不下`,
              `Requests ${gpus(req)} GPUs > quota ${w.quota} capacity ${gpus(cap)} and idle resources are forbidden: cannot fit the current configuration`) }
          : known ? { kind: "quota", level: "info", text: t(`申请 ${gpus(req)} 卡 > 配额 ${w.quota} 容量 ${gpus(cap)} 卡：只能等闲时资源（已选“${strategyText(w.strategy)}”）`,
              `Requests ${gpus(req)} GPUs > quota ${w.quota} capacity ${gpus(cap)}: waits for idle resources (${strategyText(w.strategy)})`) }
          : { kind: "quota", level: "risk", text: t(`申请 ${gpus(req)} 卡 > 配额 ${w.quota} 容量 ${gpus(cap)} 卡：配额内放不下，只能等闲时资源；提交策略未取得，若选了“不接受闲时资源”将一直排队`,
              `Requests ${gpus(req)} GPUs > quota ${w.quota} capacity ${gpus(cap)}: needs idle resources; strategy unknown, stays queued if idle resources are forbidden`) });
        // 单 Pod 规格：DLC 用 worker 规格（总卡数可能是多 Pod 之和），DSW 是单实例。
        const pods = w.WorkloadType === "dsw" ? (req != null ? [{ type: "DSW", gpu: req }] : []) : w.specs;
        pods.filter((sp) => maxNodeGpu && num(sp.gpu) > maxNodeGpu).forEach((sp) => w.blockers.push({ kind: "node", level: forbidden ? "hard" : "risk",
          text: t(`${sp.type} 单个 Pod 申请 ${gpus(sp.gpu)} 卡 > 本配额节点单机 ${maxNodeGpu} 卡：这些节点都放不下` + (forbidden ? "，且不接受闲时资源" : "；闲时资源节点规格未核实"),
            `${sp.type} pod requests ${gpus(sp.gpu)} GPUs > ${maxNodeGpu} per node in this quota` + (forbidden ? " and idle resources are forbidden" : "; idle-resource specs unverified")) }));
        if (w.WorkloadType === "dlc" && !w.job) w.blockers.push({ kind: "platform", level: "info", text: t("任务详情尚未取得：单 Pod 规格与提交策略未知", "Job detail not fetched yet: pod spec and strategy unknown") });
      }
      w.blocked = w.blockers.some((b) => b.level === "hard");
      w.unschedulable = w.blockers.some((b) => b.level === "hard" || b.level === "risk");
      const dims = new Map();
      w.metrics.forEach((m) => {
        const key = m.pod + "\u0000" + m.gpu;
        if (!dims.has(key)) dims.set(key, { pod: m.pod, gpu: m.gpu, compute: null, memory: null });
        dims.get(key)[m.metric] = m;
      });
      w.gpus = [...dims.values()].sort((a, b) => a.pod.localeCompare(b.pod) || a.gpu.localeCompare(b.gpu, undefined, { numeric: true }));
      // 均值保留最近成功值并标陈旧；"计算 <5%"只按新鲜值统计，陈旧数据不触发提醒。
      const latest = (metric, freshOnly) => w.gpus.map((g) => g[metric]).filter((m) => m && (m.fresh || !freshOnly)).map((m) => m.value);
      w.compute = mean(latest("compute"));
      w.memory = mean(latest("memory"));
      w.measured = latest("compute", true).length;
      w.low = w.gpus.filter((g) => isLow(g.compute)).length;
      w.stale = w.metrics.some((m) => !m.fresh);
      const byNode = new Map();
      w.cards.forEach((c) => {
        if (!byNode.has(c.node)) byNode.set(c.node, []);
        byNode.get(c.node).push(c.index);
      });
      w.nodes = [...byNode].map(([name, idx]) => ({ name, short: short(name), indices: idx.sort((a, b) => a - b) }));
    });
    d.users.forEach((u) => {
      u.workloads = d.workloads.filter((w) => w.UserId === u.UserId);
      const latest = (metric) => u.workloads.flatMap((w) => w.gpus.map((g) => g[metric]).filter(Boolean).map((m) => m.value));
      u.compute = mean(latest("compute"));
      u.memory = mean(latest("memory"));
      u.stale = u.workloads.some((w) => w.stale);
      u.low = u.workloads.reduce((a, w) => a + w.low, 0);
      u.mapped = cards.filter((c) => c.assignments.some((a) => a.owner_id === u.UserId)).length;
    });
    const physicalMem = cards.filter((c) => c.memory?.fresh).map((c) => c.memory.value);
    const gpuOf = (w) => num(w.requested_gpu) || 0;
    const running = d.workloads.filter((w) => w.WorkloadStatus === "Running" && !w.queued);
    const quotaName = (id) => quotas[id]?.quota_name || id || "—";
    const childrenOf = (id) => (d.quotas || []).filter((c) => c.parent_quota_id === id);
    const subtree = (id) => [id, ...childrenOf(id).flatMap((c) => subtree(c.quota_id))];
    const byId = Object.fromEntries(d.workloads.map((w) => [w.WorkloadId, w]));
    // 节点自愈受阻：健康异常的节点上仍有任务时，需要提交者先保存，再重启 DSW 或停止 / 迁移 DLC。
    d.nodes.forEach((n) => {
      n.healTasks = (n.unhealthy ? n.workloadIds : []).map((id) => byId[id]).filter(Boolean);
      n.healTasks.forEach((w) => { w.healNode = n; });
    });
    const usersOf = (list) => {
      const m = new Map();
      list.forEach((w) => {
        const e = m.get(w.UserId) || { id: w.UserId, name: w.UserName || "—", gpus: 0, jobs: 0 };
        e.gpus += gpuOf(w);
        e.jobs += 1;
        m.set(w.UserId, e);
      });
      return [...m.values()].filter((u) => u.gpus > 0).sort((a, b) => b.gpus - a.gpus || a.name.localeCompare(b.name));
    };
    const total = (list) => list.reduce((a, u) => a + u.gpus, 0);
    // 配额归属：配额内任务按 QuotaId 归入其直接提交的配额；闲时任务单列，不计入配额用量。
    (d.quotas || []).forEach((q) => {
      const own = running.filter((w) => w.QuotaId === q.quota_id);
      q.direct = usersOf(own.filter((w) => !w.oversold));
      q.oversoldUsers = usersOf(own.filter((w) => w.oversold));
      q.directGpu = total(q.direct);
      q.oversoldGpu = total(q.oversoldUsers);
      q.childUsed = childrenOf(q.quota_id).reduce((a, c) => a + (num(c.gpu_used) || 0), 0);
      // 父配额任务占用本配额的节点：节点绑定本配额，但任务不属于本配额及其子配额。
      const mine = new Set(subtree(q.quota_id));
      const lent = new Map();
      if (q.quota_id !== d.quota_id) d.nodes.filter((n) => n.quotaIds.includes(q.quota_id)).forEach((n) => n.cards.forEach((c) => c.assignments.forEach((a) => {
        const w = byId[a.workload_id];
        if (!w || mine.has(w.QuotaId)) return;
        const e = lent.get(a.owner_id) || { id: a.owner_id, name: a.owner_name || "—", gpus: 0, quota: quotaName(w.QuotaId) };
        e.gpus += 1;
        lent.set(a.owner_id, e);
      })));
      q.borrowedBy = [...lent.values()].sort((a, b) => b.gpus - a.gpus);
      // 绑定节点中能接新任务的数量：禁止调度或健康异常的不算。配置容量不等于健康可调度的卡。
      const bound = q.quota_id === d.quota_id ? d.nodes : d.nodes.filter((n) => n.quotaIds.includes(q.quota_id));
      q.nodesTotal = bound.length;
      q.nodesSchedulable = bound.filter((n) => n.NodeStatus === "Ready" && !n.unhealthy).length;
      // 新采集器提供配额分配明细（本配额 / 子配额 / 父配额任务）；旧快照只有用量，退回粗略核对。
      q.hasBreakdown = num(q.allocated_gpu) != null && num(q.self_allocated_gpu) != null;
      q.expected = q.hasBreakdown ? q.directGpu : q.directGpu + q.childUsed;
      q.reported = q.hasBreakdown ? num(q.self_allocated_gpu) : num(q.gpu_used);
      q.mismatch = q.reported != null && Math.abs(q.reported - q.expected) > 1e-6;
    });
    d.users.forEach((u) => {
      const byQuota = new Map();
      running.filter((w) => w.UserId === u.UserId && gpuOf(w) > 0).forEach((w) => {
        const key = w.QuotaId + (w.oversold ? "|oversold" : "");
        const e = byQuota.get(key) || { id: w.QuotaId, name: quotaName(w.QuotaId), gpus: 0, oversold: w.oversold };
        e.gpus += gpuOf(w);
        byQuota.set(key, e);
      });
      u.quotaUse = [...byQuota.values()].sort((a, b) => a.oversold - b.oversold || b.gpus - a.gpus);
      u.oversoldGpu = u.quotaUse.filter((x) => x.oversold).reduce((a, x) => a + x.gpus, 0);
    });
    d.cardsFlat = cards;
    d.sx = {
      physical: cards.length,
      free: cards.filter((c) => c.state === "free").length,
      unknown: cards.filter((c) => c.state === "unknown").length,
      memoryMean: mean(physicalMem),
      types: [...new Set(d.nodes.map((n) => n.GPUType).filter(Boolean))],
      running: running.length,
      dsw: running.filter((w) => w.WorkloadType === "dsw").length,
      dlc: running.filter((w) => w.WorkloadType === "dlc").length,
      lowDims: d.workloads.reduce((a, w) => a + w.low, 0),
      oversoldLow: d.workloads.filter((w) => w.oversold).reduce((a, w) => a + w.low, 0),
      measuredDims: d.workloads.reduce((a, w) => a + w.measured, 0),
      oversoldGpu: running.filter((w) => w.oversold).reduce((a, w) => a + gpuOf(w), 0),
      oversoldJobs: running.filter((w) => w.oversold && gpuOf(w) > 0).length,
      queued: d.workloads.filter((w) => w.queued).sort((a, b) => b.unschedulable - a.unschedulable || (b.queuedFor ?? 0) - (a.queuedFor ?? 0)),
      unschedulable: d.workloads.filter((w) => w.unschedulable),
      blocked: d.workloads.filter((w) => w.blocked),
      // 闲时任务按设计不公开节点，不算"未关联"缺口。
      unmapped: d.workloads.filter((w) => w.metrics.length && !w.cards.length && !w.oversold),
      hidden: d.workloads.filter((w) => w.oversold && !w.cards.length),
      conflicts: d.users.filter((u) => u.conflict),
      quotaMismatch: (d.quotas || []).filter((q) => q.mismatch),
      unhealthy: d.nodes.filter((n) => n.unhealthy),
      healBlocked: d.nodes.filter((n) => n.healTasks.length),
    };
    d.updatedAt = d.round?.finished_at || null;
    return d;
  }

  // ── 单卡 ───────────────────────────────────────────────
  // 数字 = 计算利用率（热力色），底部细条 = 显存占用（紫色）；空闲卡虚线，未知卡斜纹。
  function cardTip(c, opts) {
    const lines = [(opts.label || "GPU " + c.index)];
    if (c.state === "free") lines.push(t("未见占用：节点 GPU 请求为 0，且与 Pod 映射一致。闲时任务的物理位置不公开，可能未计入", "No visible allocation: node GPU request is 0 and matches Pod mapping. Idle-time pods are hidden and may not be counted"));
    if (c.state === "unknown") lines.push(t("分配状态未知：Pod 映射缺失或与节点请求量不一致", "Allocation unknown: Pod mapping missing or inconsistent"));
    if (c.compute || c.state === "measured" || c.state === "assigned") {
      lines.push(t("计算 ", "Compute ") + pct1(c.compute?.value) + (c.compute && !c.compute.fresh ? t("（陈旧）", " (stale)") : ""));
      lines.push(t("显存 ", "Memory ") + pct1(c.memory?.value) + (c.memory && !c.memory.fresh ? t("（陈旧）", " (stale)") : ""));
      if (c.compute) lines.push(t("源采样 ", "Sampled ") + clock(c.compute.sampled_at));
    }
    (c.assignments || []).forEach((a) => lines.push((a.owner_name || "—") + " · " + (a.workload_id || "—") + (a.fresh ? "" : t("（上次关联）", " (last seen)"))));
    if (c.compute?.recent != null) lines.push(t(`近 10 分钟计算均值 ${pct1(c.compute.recent)}（${c.compute.recent_n} 个点）`, `10-min compute mean ${pct1(c.compute.recent)} (${c.compute.recent_n} points)`));
    if (c.low) lines.push(t(`已分配但近 10 分钟计算 <${LOW}%`, `Allocated, 10-min compute under ${LOW}%`));
    return lines.join("\n");
  }

  function cardParts(c) {
    const v = c.compute?.value;
    const color = c.state === "measured" ? UI.utilColor(v).bg : null;
    const mem = c.memory?.value;
    const style = (color ? `--util-color:${color};` : "") + (mem != null ? `--mem-f:${Math.max(0, Math.min(100, mem)) / 100};` : "");
    const cls = " " + c.state + (c.low ? " low" : "") + (c.stale ? " stale" : "");
    const text = c.state === "measured" ? String(Math.round(v)) : c.state === "free" ? "" : c.state === "unknown" ? "?" : "—";
    return { style, cls, text, mem };
  }

  // 紧凑格（热力图），8 卡一行
  function cell(c, opts) {
    const p = cardParts(c);
    return el("span", { class: "pai-cell" + p.cls, style: p.style, title: cardTip(c, opts || {}) }, [p.text]);
  }

  // 完整卡（节点页 / 任务页），沿用裸金属 .card 的结构
  function card(c, opts) {
    opts = opts || {};
    const p = cardParts(c);
    const sub = c.state === "free" ? t("未占用", "Free?") : c.state === "unknown" ? t("未知", "Unknown")
      : t("显存 ", "Mem ") + (p.mem == null ? "—" : Math.round(p.mem) + "%");
    return el(opts.href ? "a" : "div", { class: "card pai-card" + p.cls, style: p.style, href: opts.href || null, title: cardTip(c, opts) }, [
      el("span", { class: "idx" }, ["#" + (opts.index ?? c.index)]),
      el("span", { class: "now" + (p.text.length >= 3 ? " now-wide" : "") }, [p.text]),
      c.low ? el("span", { class: "held-mark" }) : (c.state === "measured" ? el("span", { class: "signal" }) : null),
      el("span", { class: "avg" }, [sub]),
    ]);
  }

  function legend() {
    const bands = [[5, t("空闲", "Idle")], [20, t("在用", "In use")], [50, t("偏忙", "Busy")], [80, t("繁忙", "Very busy")], [95, t("满载", "Full")]];
    return el("div", { class: "pai-legend" }, [
      el("span", { class: "pai-legend-cap" }, [t("计算", "Compute")]),
      ...bands.map(([v, label]) => el("span", {}, [el("i", { style: `background:${UI.utilColor(v).bg}` }), label])),
      el("span", {}, [el("i", { class: "mem" }), t("显存（底条）", "Memory (bar)")]),
      el("span", {}, [el("i", { class: "low" }), t(`已分配·近10分钟计算<${LOW}%`, `Allocated, 10-min <${LOW}%`)]),
      el("span", {}, [el("i", { class: "free" }), t("未见占用", "No visible allocation")]),
      el("span", {}, [el("i", { class: "unknown" }), t("未知", "Unknown")]),
    ]);
  }

  // ── 页头 ───────────────────────────────────────────────
  function alertBox(value, label, tone, title, opts) {
    opts = opts || {};
    return el(opts.onclick ? "button" : "div", { class: "alert" + (tone ? " " + tone : "") + (opts.onclick ? " clickable" : ""), title: title || "",
      type: opts.onclick ? "button" : null, onclick: opts.onclick || null }, [
      el("b", {}, [String(value)]), el("span", {}, [label]), opts.sub ? el("small", { class: "alert-sub" }, [opts.sub]) : null]);
  }

  // 页头提醒的跳转：低负载 → 任务表按低负载排序；需核对 → 第一类问题所在位置。
  function goLowUtil() {
    Object.assign(ui, { sort: "low", desc: true, type: "all", q: "" });
    if (location.hash === "#/pai/workloads") GM.render(); else GM.go("/pai/workloads");
  }
  function scrollToId(id, fallbackPath) {
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (fallbackPath) GM.go(fallbackPath);
  }

  // 本环境处理口径：提交者保存数据与环境后重启 DSW，节点随后自愈；平台不会替用户直接重启。
  function healText(n, w) {
    const state = n.ReasonCode === "Recovering" ? t("自愈中", "self-healing") : t("健康异常", "unhealthy");
    const who = w.UserName || t("提交者", "the owner");
    return w.WorkloadType === "dsw"
      ? t(`节点 ${n.short} ${state}：等待 ${who} 保存数据和环境后重启 DSW「${w.WorkloadName}」，以继续节点自愈。`,
        `Node ${n.short} is ${state}: waiting for ${who} to save data and environment, then restart DSW "${w.WorkloadName}" so healing can continue.`)
      : t(`节点 ${n.short} ${state}：等待 ${who} 保存后停止或迁移任务「${w.WorkloadName}」，以继续节点自愈。`,
        `Node ${n.short} is ${state}: waiting for ${who} to save, then stop or migrate "${w.WorkloadName}" so healing can continue.`);
  }

  function nodeChips(n) {
    const tip = [n.ReasonCode && "ReasonCode " + n.ReasonCode, n.ReasonMessage && t("平台返回的自愈时间 ", "self-heal time from platform ") + n.ReasonMessage,
      n.healthPct != null && t("健康度 ", "health ") + Math.round(n.healthPct) + "%"].filter(Boolean).join(" · ");
    return [n.NodeStatus !== "Ready" ? chip(n.NodeStatus) : null,
      n.unhealthy ? el("span", { class: "pai-chip bad", title: tip }, [n.ReasonCode ? stateText(n.ReasonCode) : t("健康度 ", "Health ") + Math.round(n.healthPct) + "%"]) : null];
  }

  function allocationBar(m) {
    const s = m.sx;
    const assigned = m.cardsFlat.filter((c) => c.assignments.length).length;
    const seg = (n, cls, label) => (n ? el("span", { class: "seg " + cls, style: `flex:${n}`, title: `${label} ${n}` }) : null);
    return el("div", { class: "pai-alloc" }, [
      el("div", { class: "pai-alloc-bar" }, [
        seg(assigned, "used", t("已分配", "Allocated")), seg(s.unknown, "unknown", t("未知", "Unknown")), seg(s.free, "free", t("未见占用", "No visible allocation")),
      ]),
      el("div", { class: "pai-alloc-legend" }, [
        el("span", {}, [el("i", { class: "used" }), t(`已分配 ${assigned}`, `Allocated ${assigned}`)]),
        s.unknown ? el("span", {}, [el("i", { class: "unknown" }), t(`未知 ${s.unknown}`, `Unknown ${s.unknown}`)]) : null,
        el("span", {}, [el("i", { class: "free" }), t(`未见占用 ${s.free}`, `No visible allocation ${s.free}`)]),
        el("span", { class: "pai-alloc-total" }, [t(`共 ${s.physical} 张物理卡`, `${s.physical} physical GPUs`)]),
      ]),
    ]);
  }

  function header(m) {
    const s = m.sx;
    // 需核对：按类别列出非零项；点击跳到第一项所在位置。
    const healing = s.unhealthy.filter((n) => n.ReasonCode === "Recovering").length;
    const issues = [
      [healing, t("节点自愈中", "node self-healing"), () => scrollToId(s.healBlocked.length ? "paiHealNote" : "paiHeat")],
      [s.unhealthy.length - healing, t("节点健康异常", "unhealthy node"), () => scrollToId("paiHeat")],
      [s.quotaMismatch.length, t("配额申请≠分配", "quota mismatch"), () => scrollToId("paiQuotas")],
      [s.unmapped.length, t("任务未关联节点", "unmapped workloads"), () => GM.go("/pai/workloads")],
      [s.conflicts.length, t("用户用量冲突", "usage conflicts"), () => GM.go("/pai/users")],
    ].filter(([n]) => n > 0);
    // 只有一类时大数字就是它的数量，标签不再重复数字。
    const issueLabel = ([n, name]) => (issues.length === 1 ? name : `${name} ${n}`);
    const attention = issues.reduce((a, [n]) => a + n, 0);
    const copy = el("div", { class: "command-copy" }, [
      el("div", { class: "eyebrow" }, ["PAI · " + (m.region || "—")]),
      el("h1", {}, [t("PAI 资源监控", "PAI resources")]),
      el("div", { class: "pai-head-meta" }, [
        chip(m.state),
        el("span", {}, [t("更新于 ", "Updated ") + ago(m.updatedAt)]),
        el("span", {}, [t(`每 ${m.poll_interval_s} 秒采集`, `Every ${m.poll_interval_s}s`)]),
        el("span", {}, ["Workspace " + (m.workspace_id || "—")]),
      ]),
    ]);
    const side = el("div", { class: "pai-head-side" }, [
      el("div", { class: "ops-strip", style: `--alert-count:${s.queued.length ? 4 : 3}` }, [
        alertBox(s.free, t("未见 GPU 占用的卡", "GPUs with no visible allocation"), s.free ? "good" : "",
          t("节点清单中 GPU 请求为 0、且与 Pod 映射一致的卡。闲时任务的物理位置不公开、可能未计入；能否调度还取决于 CPU、内存、健康和配额策略，不代表一定能立即使用。",
            "Node GPU request is 0 and matches Pod mapping. Idle-time pods are hidden and may not be counted; schedulability also depends on CPU, memory, health and quota policy.")),
        alertBox(s.lowDims, t(`已分配但近 10 分钟计算 <${LOW}%`, `Allocated, 10-min compute <${LOW}%`), s.lowDims ? "hot" : "",
          t(`按任务的卡统计（闲时卡没有物理节点，不能按物理卡算），用近 10 分钟均值判断，至少 5 个分钟点。点击查看任务，按低负载卡数排序。`,
            `Counted per workload GPU (idle-time GPUs have no physical node), using the 10-minute mean with at least 5 points. Click to open workloads sorted by low-utilization GPUs.`),
          { sub: s.lowDims ? t(`配额内 ${s.lowDims - s.oversoldLow} · 闲时 ${s.oversoldLow}`, `in quota ${s.lowDims - s.oversoldLow} · idle-time ${s.oversoldLow}`) : null,
            onclick: s.lowDims ? goLowUtil : null }),
        alertBox(attention, attention ? issueLabel(issues[0]) : t("需核对：无", "Nothing to reconcile"), attention ? "hot" : "",
          t("需核对包括：节点自愈中或健康异常、配额申请与分配不一致、配额内任务未关联节点、用户用量冲突。点击跳到第一项。",
            "Covers self-healing or unhealthy nodes, quota mismatches, unmapped in-quota workloads and usage conflicts. Click to jump to the first item."),
          { sub: issues.length > 1 ? issues.slice(1).map(issueLabel).join(" · ") : null, onclick: attention ? issues[0][2] : null }),
        s.queued.length ? alertBox(s.queued.length, s.unschedulable.length ? t(`排队（${s.unschedulable.length} 个可能排不上）`, `Queued (${s.unschedulable.length} may never fit)`) : t("排队任务", "Queued"),
          s.unschedulable.length ? "bad" : "hot", t("详情见页面顶部的排队横幅", "See the queue banner above")) : null,
      ]),
      allocationBar(m),
    ]);
    return el("section", { class: "command-panel pai-head" }, [copy, side]);
  }

  // 非总览页的紧凑状态行：保留新鲜度与关键数字，不重复整块页头。
  function slimHeader(m) {
    const s = m.sx, sum = m.summary || {};
    const item = (label, value, tone) => el("span", { class: "pai-slim-item" + (tone ? " " + tone : "") }, [el("b", {}, [value]), label]);
    return el("section", { class: "pai-slim" }, [
      el("div", { class: "pai-slim-title" }, [el("span", { class: "eyebrow" }, ["PAI · " + (m.region || "—")]), chip(m.state),
        el("span", { class: "pai-muted" }, [t("更新于 ", "Updated ") + ago(m.updatedAt)])]),
      el("div", { class: "pai-slim-items" }, [
        item(t("未见占用", "no visible allocation"), String(s.free), s.free ? "good" : ""),
        item(t("已分配", "allocated"), `${sum.mapped_gpus ?? "—"} / ${s.physical}`),
        item(t("计算均值（任务）", "task mean"), pct(sum.task_compute_mean)),
        item(t("集群占用", "cluster utilization"), pct(sum.cluster_compute_mean)),
        item(t("运行任务", "running"), String(s.running)),
        s.oversoldGpu ? item(t("闲时卡", "idle-time"), String(s.oversoldGpu), "oversold") : null,
      ]),
    ]);
  }

  const taskMeanHint = (sum) => t(`运行任务中 ${sum.task_measured_gpus || 0} 张 GPU 的新鲜指标，每卡等权；含闲时任务，缺测不计零`,
    `Fresh metrics from ${sum.task_measured_gpus || 0} GPUs in running tasks, weighted equally per GPU; includes idle-time tasks, excludes missing values`);
  const clusterMeanHint = (sum) => t(`全部 ${gpus(sum.physical_gpus)} 张物理卡平均，未占用按 0%；已确认 ${sum.cluster_known_gpus || 0} 张，缺测时不显示均值`,
    `Mean across all ${gpus(sum.physical_gpus)} physical GPUs; unallocated = 0%. ${sum.cluster_known_gpus || 0} confirmed; no mean when data is incomplete`);

  function kpis(m) {
    const s = m.sx, sum = m.summary || {};
    const items = [
      [String(s.physical), t("物理 GPU", "Physical GPUs"), plural(m.nodes.length, "节点", "node") + (s.types.length ? " · " + s.types.join(" / ") : "")],
      [sum.mapped_gpus == null ? "—" : `${sum.mapped_gpus} / ${s.physical}`, t("已分配物理卡", "Allocated GPUs"), t("按 Pod GPUIndexes 去重", "Deduplicated from Pod GPUIndexes")],
      [pct(sum.task_compute_mean), t("计算均值（任务）", "Compute mean (tasks)"), taskMeanHint(sum)],
      [pct(sum.cluster_compute_mean), t("集群占用", "Cluster utilization"), clusterMeanHint(sum)],
      [String(s.running), t("运行中任务", "Running workloads"), `DSW ${s.dsw} · DLC ${s.dlc}`],
      [String(s.oversoldGpu), t("闲时资源卡（配额外）", "Idle-time GPUs"), t(`${s.oversoldJobs} 个任务 · 不计入配额 · 可被回收`, `${s.oversoldJobs} workloads · outside quota · reclaimable`), "idle"],
    ];
    return el("div", { class: "kpis pai-kpis" }, items.map(([v, k, hint, docKey]) => el("div", { class: "kpi" + (docKey ? " oversold" : "") }, [
      el("div", { class: "v" }, [v]), el("div", { class: "k" }, [k, docKey ? doc(docKey, t("说明", "Docs")) : null]),
      el("div", { class: "hint", title: hint }, [hint]),
    ])));
  }

  function tabs(m, active) {
    const items = [["overview", t("总览", "Overview"), null], ["nodes", t("节点", "Nodes"), m.nodes.length],
      ["workloads", t("任务", "Workloads"), m.workloads.length], ["users", t("用户", "Users"), m.users.length], ["ranking", t("排行", "Ranking"), null]];
    return el("nav", { class: "pai-tabs", "aria-label": "PAI" }, items.map(([key, label, n]) =>
      el("a", { href: href(key), class: key === active ? "active" : "" }, [label, n == null ? null : el("span", { class: "count" }, [String(n)])])));
  }

  function panel(title, children, opts) {
    opts = opts || {};
    return el("section", { class: "panel pai-panel" + (opts.cls ? " " + opts.cls : ""), id: opts.id || null }, [
      el("div", { class: "pai-panel-head" }, [el("h3", {}, [title]), opts.tools || null]), ...children]);
  }

  function back(label, path) {
    return el("a", { class: "back", href: path }, ["‹ " + label]);
  }

  // ── 节点 ───────────────────────────────────────────────
  function nodeTile(n) {
    const who = n.owners.length ? n.owners.join(" · ") : n.free === n.cards.length ? t("未见占用", "No visible allocation") : "—";
    return el("a", { class: "pai-node-tile" + (n.NodeStatus !== "Ready" || n.unhealthy ? " cordoned" : ""), href: href("node", n.NodeName),
      title: n.NodeName + (n.quotaNames.length ? "\n" + t("所属配额：", "Quota: ") + n.quotaNames.join(", ") : "")
        + n.healTasks.map((w) => "\n" + healText(n, w)).join("") }, [
      el("div", { class: "pai-node-tile-head" }, [el("span", { class: "pai-node-name" }, [n.short]), ...nodeChips(n)]),
      el("div", { class: "pai-node-tile-sub" }, [
        n.quotaNames.length ? el("span", { class: "pai-node-quota" }, [n.quotaNames.join(", ")]) : null,
        el("span", { class: "pai-node-who" + (n.owners.length ? "" : " free") }, [who]),
      ]),
      el("div", { class: "pai-cells" }, n.cards.map((c) => cell(c))),
    ]);
  }

  function heatPanel(m) {
    const s = m.sx;
    return panel(t("物理卡热力", "Physical GPU heatmap"), [
      ...s.healBlocked.flatMap((n, i) => n.healTasks.map((w, j) => el("div", { class: "pai-note warn", id: !i && !j ? "paiHealNote" : null }, [healText(n, w), " ",
        link(t("查看任务", "Open workload"), href("workload", w.WorkloadId)), " ", doc("selfHeal")]))),
      el("div", { class: "pai-node-grid" }, m.nodes.map(nodeTile)),
      s.oversoldGpu ? el("div", { class: "pai-note oversold" }, [t(
        `${s.oversoldJobs} 个运行任务使用闲时资源，申请共 ${s.oversoldGpu} 卡。这是任务申请量，与图中物理卡的对应关系未确认，不代表额外物理容量。`,
        `${s.oversoldJobs} running workloads use idle-time resources and request ${s.oversoldGpu} GPUs in total. This is requested capacity, not additional physical capacity; correspondence with the GPUs shown is unconfirmed. `), doc("idle")]) : null,
    ], { tools: legend(), id: "paiHeat" });
  }

  function nodeRow(n, m) {
    const byId = Object.fromEntries(m.workloads.map((w) => [w.WorkloadId, w]));
    const jobs = n.workloadIds.map((id) => byId[id]).filter(Boolean);
    return el("div", { class: "pai-node-row" }, [
      el("a", { class: "pai-node-id", href: href("node", n.NodeName), title: n.NodeName }, [
        el("b", {}, [n.short]),
        el("small", {}, [`${n.GPUType || "GPU"} · ${gpus(n.GPU)} GPU` + (n.quotaNames.length ? " · " + n.quotaNames.join(", ") : "")]),
        el("span", { class: "pai-inline" }, nodeChips(n)),
      ]),
      el("div", { class: "pai-node-jobs" }, jobs.length ? jobs.map((w) => el("div", {}, [
        link(w.WorkloadName, href("workload", w.WorkloadId)), el("small", {}, [" · " + (w.UserName || "—")]),
      ])) : [el("span", { class: "pai-muted" }, [n.free ? t(`未见占用 ${n.free} 卡`, `${n.free} with no visible allocation`) : t("无关联任务", "No mapped workload")])]),
      el("div", { class: "cards" }, n.cards.map((c) => card(c, {
        href: c.assignments[0] ? href("workload", c.assignments[0].workload_id) : null }))),
    ]);
  }

  function nodesPanel(m) {
    const filters = [["all", t("全部", "All"), m.nodes.length], ["busy", t("有任务", "In use"), m.nodes.filter((n) => n.assigned).length],
      ["free", t("有未见占用的卡", "Has unallocated"), m.nodes.filter((n) => n.free).length]];
    const list = el("div", { class: "pai-node-list" });
    const draw = () => {
      const rows = m.nodes.filter((n) => ui.nodes === "all" || (ui.nodes === "busy" ? n.assigned : n.free))
        .sort((a, b) => b.assigned - a.assigned || a.NodeName.localeCompare(b.NodeName));
      list.replaceChildren(...(rows.length ? rows.map((n) => nodeRow(n, m)) : [note(t("没有符合条件的节点", "No matching nodes"))]));
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === ui.nodes));
    };
    const seg = el("div", { class: "pai-seg" }, filters.map(([k, label, n]) => el("button", {
      "data-k": k, onclick: () => { ui.nodes = k; draw(); } }, [label, el("span", { class: "count" }, [String(n)])])));
    draw();
    return panel(t("节点与单卡", "Nodes & GPUs"), [legend(), list], { tools: seg });
  }

  // ── 任务 ───────────────────────────────────────────────
  function nodeCell(w) {
    if (w.nodes.length) return el("div", { class: "pai-node-links" }, w.nodes.map((n) => el("div", {}, [
      link(n.short, href("node", n.name), "mono"),
      el("small", {}, [" · GPU " + rangeText(n.indices)]),
    ])));
    if (w.oversold) return oversoldChip(t("闲时 · 节点不公开", "Idle-time · hidden"));
    if (w.metrics.length) return el("span", { class: "pai-chip muted", title: t("有单卡指标，但没有可信的物理节点关联", "Has GPU metrics but no trusted node mapping") }, [t("未关联", "Unmapped")]);
    return el("span", { class: "pai-dash" }, ["—"]);
  }

  function rangeText(idx) {
    if (!idx.length) return "—";
    const contiguous = idx.every((v, i) => !i || v === idx[i - 1] + 1);
    return contiguous && idx.length > 2 ? `${idx[0]}–${idx[idx.length - 1]}` : idx.join(",");
  }

  function strip(w) {
    if (!w.gpus.length) return el("span", { class: "pai-dash" }, ["—"]);
    return el("span", { class: "pai-strip" }, w.gpus.map((g) => {
      const v = g.compute ? g.compute.value : null;
      return el("i", {
        class: (v == null ? "none" : isLow(g.compute) ? "low" : "") + (g.compute && !g.compute.fresh ? " stale" : ""),
        style: v == null ? "" : `--c:${UI.utilColor(v).bg}`,
        title: `${g.pod} / GPU ${g.gpu}\n${t("计算 ", "Compute ")}${pct1(g.compute?.value)}${g.compute?.recent_mean != null ? t(`（近 10 分钟 ${pct1(g.compute.recent_mean)}）`, ` (10-min ${pct1(g.compute.recent_mean)})`) : ""} · ${t("显存 ", "Memory ")}${pct1(g.memory?.value)}`,
      });
    }));
  }

  function stateCell(w) {
    if (w.queued) return el("span", { class: "pai-inline", title: w.blockers.map((b) => b.text).join("\n") || t("排队顺序见调度策略", "See scheduling policies for queue order") }, [
      w.blocked ? el("span", { class: "pai-chip bad strong" }, [t("当前配置放不下", "Cannot fit now")])
        : w.unschedulable ? el("span", { class: "pai-chip bad" }, [t("可能排不上", "May not fit")]) : chip(w.WorkloadStatus === "Pending" ? "Pending" : "Queuing"),
      num(w.queue_position) ? el("small", { class: "pai-muted" }, [t(`第 ${w.queue_position} 位`, `#${w.queue_position}`)]) : null,
      w.queuedFor != null ? el("small", { class: w.longWait ? "pai-low" : "pai-muted" }, [t("已等 ", "waited ") + dur(w.queuedFor)]) : null]);
    return chip(w.WorkloadStatus);
  }

  // 排队横幅：在所有 PAI 页顶部醒目列出排队任务，硬性不满足的排在最前、红色标出。
  function queueBanner(m) {
    const list = m.sx.queued;
    if (!list.length) return null;
    const bad = m.sx.unschedulable.length, hard = m.sx.blocked.length;
    return el("section", { class: "pai-queue" + (bad ? " bad" : "") }, [
      el("div", { class: "pai-queue-head" }, [
        el("strong", {}, [t(`排队中的任务 ${list.length} 个`, `${list.length} queued workloads`)
          + (hard ? t(`，${hard} 个当前配置放不下`, `, ${hard} cannot fit now`) : "")
          + (bad - hard ? t(`，${bad - hard} 个可能排不上`, `, ${bad - hard} may never fit`) : "")]),
        el("span", { class: "pai-tools" }, [doc("schedule"), doc("idle", t("闲时资源", "Idle-time"))]),
      ]),
      el("div", { class: "pai-queue-list" }, list.map((w) => el("div", { class: "pai-queue-item" + (w.unschedulable ? " bad" : w.longWait ? " long" : "") }, [
        el("div", { class: "pai-queue-main" }, [
          typeChip(w.WorkloadType), link(w.WorkloadName, href("workload", w.WorkloadId), "pai-wl-name"),
          el("span", { class: "pai-muted" }, [`${w.UserName || "—"} · ${w.quota} · ${gpus(w.requested_gpu)} GPU`]),
          stateCell(w),
          w.strategy ? el("span", { class: "pai-chip muted" }, [strategyText(w.strategy)]) : null,
          w.specs.length ? el("span", { class: "pai-muted" }, [w.specs.map(specText).join("；")]) : null,
        ]),
        ...w.blockers.map((b) => el("div", { class: "pai-queue-reason " + b.level, title: b.raw || "" }, [b.kind === "platform" && b.raw ? t("平台原因：", "Scheduler: ") : "", b.text,
          b.raw && b.raw !== b.text ? el("span", { class: "mono pai-muted" }, [" (" + b.raw + ")"]) : null])),
        !w.blockers.length ? el("div", { class: "pai-queue-reason info" }, [t("平台未给出原因；页面没有发现配置风险，可能只是资源暂时不足。", "No reason from the scheduler and no configuration risk found; capacity may simply be busy.")]) : null,
      ]))),
    ]);
  }

  const SORTS = {
    name: (w) => w.WorkloadName || "", owner: (w) => w.UserName || "", gpu: (w) => num(w.requested_gpu) ?? -1,
    compute: (w) => w.compute ?? -1, memory: (w) => w.memory ?? -1, cpu: (w) => w.cpu ?? -1,
    // 从页头“计算 <5%”跳转时使用：低负载卡多的在前，同数时利用率低的在前。
    low: (w) => w.low * 1000 + (100 - (w.compute ?? 100)),
  };

  // CPU / 内存：利用率（占 Pod limit 的百分比）+ 申请量；缺测显示 —，不计 0。
  function hostCell(w) {
    const line = (label, v, req) => el("div", { class: "pai-host-line" }, [el("span", { class: "pai-muted" }, [label]),
      el("b", { class: v == null ? "pai-dash" : "" }, [pct(v)]), req ? el("small", { class: "pai-muted" }, [req]) : null]);
    return el("div", { class: "pai-host" + (w.hostStale ? " stale" : ""), title: t("利用率为 Pod 内 CPU / 内存占其 limit 的百分比；括号外为申请量", "Utilization is percent of the pod limit; requested amounts shown alongside") }, [
      line("CPU", w.cpu, w.requested_cpu != null ? t(`${gpus(w.requested_cpu)} 核`, `${gpus(w.requested_cpu)} cores`) : ""),
      line(t("内存", "RAM"), w.ram, w.requested_mem_gib != null ? `${gpus(Math.round(w.requested_mem_gib))} GiB` : ""),
    ]);
  }

  function workloadsTable(list, opts) {
    opts = opts || {};
    const sortable = !opts.static;
    const rows = list.slice();
    if (sortable) {
      const key = SORTS[ui.sort] || SORTS.gpu;
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        const r = typeof x === "string" ? x.localeCompare(y) : x - y;
        return (ui.desc ? -r : r) || (b.compute ?? -1) - (a.compute ?? -1);
      });
    }
    // 排队任务固定置顶，硬性不满足的最前。
    rows.sort((a, b) => (b.unschedulable - a.unschedulable) || (b.queued - a.queued));
    const cols = [["name", t("任务", "Workload")], ["owner", "Owner"], ["gpu", "GPU", "num"], ["compute", t("计算均值", "Compute")],
      ["memory", t("显存均值", "Memory")], [null, t("单卡计算", "Per GPU")], ["cpu", t("CPU · 内存", "CPU · RAM")], [null, t("节点", "Node")], [null, t("状态", "State")]]
      .filter(([k]) => !(opts.hideOwner && k === "owner"));
    const label = (k) => (cols.find((c) => c[0] === k) || [])[1];
    const head = el("tr", {}, cols.map(([k, label, cls]) => el("th", {
      class: (cls || "") + (k && sortable ? " sortable" : "") + (k && ui.sort === k && sortable ? " sorted" : ""),
      onclick: k && sortable ? () => { ui.desc = ui.sort === k ? !ui.desc : !["name", "owner"].includes(k); ui.sort = k; opts.redraw && opts.redraw(); } : null,
    }, [label, k && sortable && ui.sort === k ? (ui.desc ? " ↓" : " ↑") : ""])));
    const body = rows.map((w) => {
      const scheduled = num(w.scheduled_gpu), requested = num(w.requested_gpu);
      const tip = w.measured ? t(`最新计算值 ${w.measured} 卡；近 10 分钟均值 <${LOW}% 的 ${w.low} 卡`, `${w.measured} GPUs with recent compute; ${w.low} with 10-min mean under ${LOW}%`) : "";
      return el("tr", { class: w.unschedulable ? "pai-row-bad" : w.queued ? "pai-row-queued" : null }, [
        el("td", { "data-label": label("name") }, [el("div", { class: "pai-wl" }, [
          link(w.WorkloadName, href("workload", w.WorkloadId), "pai-wl-name"),
          el("div", { class: "pai-wl-sub" }, [typeChip(w.WorkloadType), el("span", {}, [w.quota]), w.oversold ? oversoldChip() : null]),
        ])]),
        opts.hideOwner ? null : el("td", { "data-label": "Owner" }, [link(w.UserName, href("user", w.UserId))]),
        el("td", { class: "num", "data-label": "GPU", title: t("任务申请卡数（逻辑量）", "Requested GPUs (logical)") }, [gpus(requested),
          scheduled != null && scheduled !== requested ? el("small", { class: "pai-muted" }, [t(` · 调度 ${gpus(scheduled)}`, ` · sched ${gpus(scheduled)}`)]) : null]),
        el("td", { "data-label": label("compute") }, [el("span", { class: "pai-inline" }, [bar(w.compute, { title: tip, stale: w.stale }),
          w.low ? el("small", { class: "pai-low" }, [t(`${w.low} 卡<${LOW}%`, `${w.low} <${LOW}%`)]) : null])]),
        el("td", { "data-label": label("memory") }, [bar(w.memory, { memory: true, stale: w.stale })]),
        el("td", { "data-label": t("单卡计算", "Per GPU") }, [strip(w)]),
        el("td", { "data-label": t("CPU · 内存", "CPU · RAM") }, [hostCell(w)]),
        el("td", { "data-label": t("节点", "Node") }, [nodeCell(w)]),
        el("td", { "data-label": t("状态", "State") }, [el("span", { class: "pai-inline" }, [stateCell(w), w.stale ? el("small", { class: "pai-low" }, [t("陈旧", "stale")]) : null])]),
      ]);
    });
    return el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table pai-wl-table" }, [
      el("thead", {}, [head]),
      el("tbody", {}, body.length ? body : [el("tr", {}, [el("td", { colspan: cols.length, class: "pai-empty" }, [t("没有符合条件的任务", "No matching workloads")])])]),
    ])]);
  }

  function workloadsPanel(m, opts) {
    opts = opts || {};
    const host = el("div");
    const types = [["all", t("全部", "All"), m.workloads.length], ["dsw", "DSW", m.workloads.filter((w) => w.WorkloadType === "dsw").length],
      ["dlc", "DLC", m.workloads.filter((w) => w.WorkloadType === "dlc").length]];
    if (m.workloads.some((w) => w.oversold)) types.push(["oversold", t("闲时", "Idle-time"), m.workloads.filter((w) => w.oversold).length]);
    if (!types.some(([k]) => k === ui.type)) ui.type = "all";
    const seg = el("div", { class: "pai-seg" }, types.map(([k, label, n]) => el("button", {
      "data-k": k, onclick: () => { ui.type = k; draw(); } }, [label, el("span", { class: "count" }, [String(n)])])));
    const search = el("input", { type: "search", class: "pai-search", value: ui.q, placeholder: t("搜索任务 / 用户 / 节点", "Search workload / user / node"),
      "aria-label": t("搜索任务", "Search workloads"), oninput: (e) => { ui.q = e.target.value; draw(); } });
    function draw() {
      const q = ui.q.trim().toLowerCase();
      let list = m.workloads.filter((w) => ui.type === "all" || (ui.type === "oversold" ? w.oversold : w.WorkloadType === ui.type));
      if (q) list = list.filter((w) => [w.WorkloadName, w.WorkloadId, w.UserName, w.quota, ...w.nodes.map((n) => n.name)]
        .some((s) => String(s || "").toLowerCase().includes(q)));
      const total = list.length;
      if (opts.limit && !q && ui.type === "all") list = list.slice().sort((a, b) => (num(b.requested_gpu) ?? 0) - (num(a.requested_gpu) ?? 0)).slice(0, opts.limit);
      const sortNote = ui.sort === "low" ? el("div", { class: "pai-sort-note" }, [
        t(`按“近 10 分钟计算 <${LOW}%”的卡数排序`, `Sorted by GPUs with 10-min compute under ${LOW}%`),
        el("button", { type: "button", class: "pai-link-btn", onclick: () => { ui.sort = "gpu"; ui.desc = true; draw(); } }, [t("恢复默认排序", "Reset sort")])]) : null;
      host.replaceChildren(...[sortNote, workloadsTable(list, { redraw: draw }),
        opts.limit && total > list.length ? el("a", { class: "pai-more", href: href("workloads") }, [t(`查看全部 ${total} 个任务 →`, `All ${total} workloads →`)]) : null].filter(Boolean));
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === ui.type));
    }
    draw();
    const unmapped = m.sx.unmapped.length, hidden = m.sx.hidden.length;
    return panel(opts.title || t("运行任务", "Workloads"), [
      hidden ? el("div", { class: "pai-note oversold" }, [t(
        `${hidden} 个任务使用闲时资源（配额外），其中 ${m.sx.oversoldJobs} 个申请 GPU、共 ${gpus(m.sx.oversoldGpu)} 卡：不计入配额用量，节点不公开，原资源方需要时会被终止。GPU 列为任务申请量。`,
        `${hidden} workloads run on idle-time resources outside the quota (${m.sx.oversoldJobs} with GPUs, ${gpus(m.sx.oversoldGpu)} total): not counted in quota usage, node names hidden, terminated when reclaimed. GPU is the requested amount. `), doc("idle")]) : null,
      unmapped ? el("div", { class: "pai-note" }, [t(
        `${unmapped} 个配额内任务有单卡指标，但没有可信的物理节点关联（节点列显示"未关联"）；它们的卡不计入上方物理卡统计。`,
        `${unmapped} in-quota workloads have GPU metrics without trusted node mapping ("Unmapped"); they are not counted as physical cards.`)]) : null,
      host,
    ], { tools: el("div", { class: "pai-tools" }, [search, seg]) });
  }

  // ── 用户与配额 ─────────────────────────────────────────
  function conflictFlag(u) {
    if (u.conflict) return el("span", { class: "pai-flag", title: t("配额统计用量为 0，但该用户仍有配额内申请 GPU 的运行任务；来源口径不一致，不视为未使用", "Quota-counted usage is 0 while in-quota GPU workloads are running; sources disagree, not treated as unused") },
      [t("口径冲突", "Mismatch")]);
    const queued = u.workloads.filter((w) => w.queued);
    if (queued.length) return el("span", { class: "pai-chip " + (queued.some((w) => w.unschedulable) ? "bad" : "warn") },
      [t(`排队 ${queued.length}`, `${queued.length} queued`)]);
    if (u.oversoldGpu) return oversoldChip(t(`闲时 ${gpus(u.oversoldGpu)}`, `Idle-time ${gpus(u.oversoldGpu)}`));
    return el("span", { class: "pai-dash" }, ["—"]);
  }

  function quotaChips(u) {
    if (!u.quotaUse.length) return el("span", { class: "pai-dash" }, ["—"]);
    return el("span", { class: "pai-inline" }, u.quotaUse.map((q) => el("span", { class: "pai-user-chip" + (q.oversold ? " oversold" : ""),
      title: q.oversold ? OVERSOLD_TIP() : t("配额内运行任务的申请卡数", "Requested GPUs of in-quota running workloads") },
      [q.name, el("b", {}, [gpus(q.gpus)]), q.oversold ? t(" 闲时", " idle-time") : null])));
  }

  function usersTable(users, compact) {
    const rows = users.slice().sort((a, b) => (num(b.submitted_gpu) ?? 0) - (num(a.submitted_gpu) ?? 0) || (a.Username || "").localeCompare(b.Username || ""));
    const userCell = (u) => compact
      ? el("div", { class: "pai-user-cell" }, [link(u.Username, href("user", u.UserId)),
        u.quotaUse.length ? el("small", {}, [u.quotaUse.map((q) => q.name + (q.oversold ? t("（闲时）", " (idle-time)") : "")).join(" · ")]) : null])
      : link(u.Username, href("user", u.UserId));
    const lowCell = (u) => (u.low ? el("span", { class: "pai-low" }, [String(u.low)]) : "0");
    // [列名, 取值, 是否数值列]
    const cols = (compact
      ? [[t("用户", "User"), userCell], [t("任务", "Jobs"), (u) => gpus(u.running_workloads), true], [t("申请 GPU", "Requested"), (u) => gpus(u.submitted_gpu), true],
        [t("计算均值", "Compute"), (u) => bar(u.compute, { stale: u.stale })], [t("显存均值", "Memory"), (u) => bar(u.memory, { memory: true, stale: u.stale })],
        [t("核对", "Check"), conflictFlag]]
      : [[t("用户", "User"), userCell], [t("运行任务", "Running"), (u) => gpus(u.running_workloads), true],
        [t("申请 GPU", "Requested GPU"), (u) => gpus(u.submitted_gpu), true], [t("所在配额", "Quotas"), quotaChips],
        [t("配额统计用量", "Quota-counted usage"), (u) => gpus(u.used_gpu), true], [t("已映射物理卡", "Mapped GPUs"), (u) => String(u.mapped), true],
        [t("计算均值", "Compute"), (u) => bar(u.compute, { stale: u.stale })], [t("显存均值", "Memory"), (u) => bar(u.memory, { memory: true, stale: u.stale })],
        [t(`计算<${LOW}%`, `<${LOW}%`), lowCell], [t("核对", "Check"), conflictFlag]]);
    const body = rows.map((u) => el("tr", {}, cols.map(([label, cell, numeric]) => el("td", { "data-label": label, class: numeric ? "num" : "" }, [cell(u)]))));
    return el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table" + (compact ? " compact" : "") }, [
      el("thead", {}, [el("tr", {}, cols.map(([label, , numeric]) => el("th", { class: numeric ? "num" : "" }, [label])))]),
      el("tbody", {}, body.length ? body : [el("tr", {}, [el("td", { colspan: cols.length, class: "pai-empty" }, [t("当前无记录", "No records")])])]),
    ])]);
  }

  function quotasPanel(m) {
    const list = (m.quotas || []).slice().sort((a, b) => (a.quota_id === m.quota_id ? -1 : b.quota_id === m.quota_id ? 1 : 0));
    const anyBreakdown = list.some((q) => q.hasBreakdown);
    const userChip = (u, cls, title, suffix) => el("a", { class: "pai-user-chip" + (cls ? " " + cls : ""), href: href("user", u.id), title },
      [u.name, el("b", {}, [gpus(u.gpus)]), suffix || null]);
    return panel(t("配额", "Quotas"), [
      el("div", { class: "pai-quotas" }, list.map((q) => {
        const cap = num(q.gpu_capacity), used = num(q.gpu_used);
        const width = (v) => (cap ? Math.max(0, Math.min(100, (v || 0) / cap * 100)) : 0);
        const root = q.quota_id === m.quota_id || !q.parent_quota_id;
        // 有分配明细时按"本配额任务 / 子配额 / 父配额任务占用"三段画；旧快照只画配额用量。
        const segs = q.hasBreakdown
          ? [["", q.self_allocated_gpu, t("本配额任务", "This quota")], ["child", q.descendants_allocated_gpu, t("子配额", "Subquotas")],
            ["borrowed", q.ancestors_allocated_gpu, t("父配额任务占用", "Used by parent quota")]]
            .filter(([, v]) => num(v)).map(([cls, v, label]) => el("i", { class: cls || null, style: `width:${width(num(v))}%`, title: `${label} ${gpus(v)}` }))
          : [el("i", { style: `width:${width(used)}%` })];
        const shown = q.hasBreakdown ? num(q.allocated_gpu) : used;
        const who = q.direct.map((u) => userChip(u, "", t(`${u.jobs} 个配额内任务直接提交到 ${q.quota_name}，共申请 ${gpus(u.gpus)} 卡`, `${u.jobs} in-quota workloads, ${gpus(u.gpus)} GPUs requested`)));
        if (num(q.childUsed) > 0) who.push(el("span", { class: "pai-user-chip child", title: t("子配额的用量合计，已包含在本配额中", "Subquota usage, included in this quota") },
          [t("子配额", "Subquotas"), el("b", {}, [gpus(q.childUsed)])]));
        if (q.borrowedBy.length) who.push(el("span", { class: "pai-quota-label" }, [t("被父配额任务占用", "Used by parent quota")]),
          ...q.borrowedBy.map((u) => userChip(u, "borrowed", t(`${u.quota} 配额的任务占用本配额节点上的 ${gpus(u.gpus)} 张卡`, `${u.quota} workloads use ${gpus(u.gpus)} GPUs on this quota's nodes`), " · " + u.quota)));
        if (q.oversoldUsers.length) who.push(...q.oversoldUsers.map((u) => userChip(u, "oversold", OVERSOLD_TIP(), t(" 闲时", " idle-time"))));
        // 控制台“闲时共享”：本级和子级资源可否被闲时任务使用（共享出去的方向）；与上级相同的子配额不重复标注。
        const parent = list.find((x) => x.quota_id === q.parent_quota_id);
        if (q.oversold_enabled != null && (root || !parent || parent.oversold_enabled !== q.oversold_enabled)) who.push(el("span", {
          class: "pai-chip " + (q.oversold_enabled ? "muted" : "warn"),
          title: t("控制台“闲时共享”：开启时，本级和子级配额的空闲资源可供闲时任务使用。它不决定本配额的任务能否借用别处资源，那由任务的提交策略决定。接口：OversoldUsageConfig.Disabled",
            "Console \"idle sharing\": when on, idle capacity of this quota and its children can be used by idle-time workloads. It does not decide whether this quota's workloads may borrow capacity; the job's policy does. API: OversoldUsageConfig.Disabled") },
          [q.oversold_enabled ? t("闲时共享：开启", "Idle sharing: on") : t("闲时共享：关闭", "Idle sharing: off")]));
        if (q.nodesTotal && q.nodesSchedulable < q.nodesTotal) who.push(el("span", { class: "pai-chip " + (q.nodesSchedulable ? "warn" : "bad"),
          title: t("绑定节点中状态就绪且健康的数量；配置容量不等于健康可调度的卡", "Bound nodes that are ready and healthy; configured capacity is not schedulable capacity") },
          [t(`可接新任务的节点 ${q.nodesSchedulable}/${q.nodesTotal}`, `Schedulable nodes ${q.nodesSchedulable}/${q.nodesTotal}`)]));
        if (q.mismatch) who.push(el("span", { class: "pai-flag", title: q.hasBreakdown
          ? t("配额内运行任务的申请卡数与配额接口的“本配额分配”不一致；页面不推断原因，需在 PAI 控制台核实。", "Requested GPUs of in-quota workloads differ from the quota's own allocation; check the PAI console.")
          : t("配额内运行任务的申请卡数（含子配额用量）与配额用量不一致；页面不推断原因，需在 PAI 控制台核实。", "Requested GPUs (plus subquota usage) differ from quota usage; check the PAI console.") },
          [t(`任务申请 ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "分配" : "用量"} ${gpus(q.reported)}`, `Requested ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "allocated" : "used"} ${gpus(q.reported)}`)]));
        return el("div", { class: "pai-quota" + (root ? " root" : "") }, [
          el("div", { class: "pai-quota-main" }, [
            el("span", { class: "pai-quota-name", title: q.quota_name }, [root ? "" : "└ ", q.quota_name || q.quota_id, root ? el("small", {}, [t(" 根", " root")]) : null]),
            el("span", { class: "pai-quota-bar" }, segs),
            el("span", { class: "pai-quota-num", title: q.hasBreakdown ? t(`已分配 ${gpus(shown)}（AllocatedQuota，含父配额任务占用）；旧 UsedQuota ${gpus(used)}（官方已标弃用）`, `Allocated ${gpus(shown)} (AllocatedQuota, incl. parent workloads); legacy UsedQuota ${gpus(used)} (deprecated)`) : "" },
              [`${gpus(shown)} / ${gpus(cap)}`]),
            q.status && q.status !== "Ready" ? chip(q.status) : null,
          ]),
          who.length ? el("div", { class: "pai-quota-users" }, [root && q.direct.length ? el("span", { class: "pai-quota-label" }, [t("直接提交", "Direct")]) : null, ...who]) : null,
        ]);
      })),
      anyBreakdown ? el("div", { class: "pai-quota-legend" }, [
        el("span", {}, [el("i"), t("本配额任务", "This quota")]), el("span", {}, [el("i", { class: "child" }), t("子配额", "Subquotas")]),
        el("span", {}, [el("i", { class: "borrowed" }), t("父配额任务占用", "Parent-quota workloads")]),
        el("span", {}, [el("i", { class: "oversold" }), t("闲时资源（不计入配额）", "Idle-time (not counted)")]),
      ]) : null,
      note(t("数字为配额资源上的实际分配 / 容量，来自配额接口；父配额包含子配额。人名按任务的 QuotaId 归入其直接提交的配额，卡数为任务申请量。“闲时共享”只在与上级不同时于子配额单独标注。",
        "Numbers are allocation / capacity from the quota API; parents include subquotas. Users are listed under the quota their workloads were submitted to, with requested GPUs. Idle sharing is shown on a subquota only when it differs from its parent.")),
    ], { tools: el("div", { class: "pai-tools" }, [doc("quota", t("配额", "Quotas")), doc("preempt", t("抢占", "Preemption")), doc("idle", t("闲时资源", "Idle-time"))]), id: "paiQuotas" });
  }

  // 页面底部：相关概念的阿里云文档
  function docsPanel() {
    return el("section", { class: "pai-docs" }, [el("span", { class: "pai-quota-label" }, [t("阿里云文档", "Alibaba Cloud docs")]),
      ...Object.keys(DOCS).map((k) => doc(k))]);
  }

  // ── 采集来源 ───────────────────────────────────────────
  function sourcesPanel(m) {
    const names = Object.fromEntries(m.workloads.map((w) => [w.WorkloadId, w.WorkloadName]));
    const label = (name) => {
      const [kind, id, metric] = name.split(":");
      if (kind === "metric") return t("指标 · ", "Metric · ") + (names[id] || id) + " · " + ({ compute: t("计算", "compute"), memory: t("显存", "GPU memory"), cpu: "CPU", ram: t("内存", "RAM") }[metric] || metric);
      if (kind === "job") return t("任务详情 · ", "Job detail · ") + (names[id] || id);
      if (kind === "pods") return t("Pod 映射 · ", "Pods · ") + (m.nodes.find((n) => n.NodeName === id)?.short || id);
      return { identity: t("身份", "Identity"), nodes: t("节点目录", "Nodes"), workloads: t("任务列表", "Workloads"),
        users: t("用户统计", "Users"), quotas: t("配额", "Quotas"), round: t("采集轮次", "Round") }[kind] || name;
    };
    const sources = (m.sources || []).slice().sort((a, b) => (a.state === "ok") - (b.state === "ok") || a.name.localeCompare(b.name));
    const bad = sources.filter((s) => s.state !== "ok").length;
    const r = m.round || {};
    const summary = [t(`采集来源 ${sources.length} 项`, `${sources.length} sources`),
      bad ? t(`${bad} 项异常`, `${bad} need attention`) : t("全部正常", "all healthy"),
      r.duration_s != null ? t(`上一轮 ${Number(r.duration_s).toFixed(1)} 秒 / ${r.calls} 次调用`, `last round ${Number(r.duration_s).toFixed(1)}s / ${r.calls} calls`) : null,
    ].filter(Boolean).join(" · ");
    const details = el("details", { id: "paiSources", class: "panel pai-sources" + (bad ? " has-bad" : "") }, [
      el("summary", {}, [el("span", { class: "dot " + (bad ? "yellow" : "green") }), summary]),
      note(t("页面只读本地快照，刷新页面不会请求云 API。", "This page reads local snapshots; refreshing never calls cloud APIs.")),
      el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table compact" }, [
        el("thead", {}, [el("tr", {}, [t("来源", "Source"), t("状态", "State"), t("最近成功获取", "Last fetch"), t("最新源采样", "Latest sample"), t("记录", "Records")].map((h) => el("th", {}, [h])))]),
        el("tbody", {}, sources.map((s) => el("tr", {}, [
          el("td", { "data-label": t("来源", "Source"), title: s.name }, [label(s.name)]),
          el("td", { "data-label": t("状态", "State") }, [chip(s.state), s.error ? el("small", { class: "pai-low" }, [" " + s.error]) : null]),
          el("td", { "data-label": t("最近成功获取", "Last fetch") }, [s.fetched_at ? ago(s.fetched_at) : "—"]),
          el("td", { "data-label": t("最新源采样", "Latest sample") }, [s.sampled_at ? clock(s.sampled_at) : "—"]),
          el("td", { "data-label": t("记录", "Records"), class: "num" }, [String(s.point_count ?? s.total ?? "—")]),
        ]))),
      ])]),
    ]);
    if (ui.sourcesOpen) details.open = true;
    details.addEventListener("toggle", () => { ui.sourcesOpen = details.open; });
    return details;
  }

  // ── 曲线 ───────────────────────────────────────────────
  function cssVar(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function seriesChart(dom, groups) {
    const text = cssVar("--chart-text", "#93a0b4"), ink = cssVar("--ink", "#eef2f8");
    const colors = UI.Palette.seriesColors(groups.filter((g) => !g.mean).length);
    const chart = echarts.init(dom);
    chart.setOption({
      backgroundColor: "transparent", color: colors, animation: false,
      // richText 模式：Pod/GPU 维度来自云端，避免作为 HTML 渲染。
      tooltip: { trigger: "axis", renderMode: "richText", backgroundColor: cssVar("--tooltip-bg", "#141924"),
        borderColor: cssVar("--tooltip-border", "#2c3543"), textStyle: { color: ink },
        valueFormatter: (v) => (v == null ? "—" : Number(v).toFixed(1) + "%") },
      legend: { type: "scroll", top: 0, left: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: text, fontSize: 11 } },
      grid: { left: 36, right: 12, top: 34, bottom: 24 },
      xAxis: { type: "time", axisLine: { lineStyle: { color: cssVar("--chart-axis", "#3a4453") } }, axisLabel: { color: text, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: "value", min: 0, max: 100, axisLabel: { color: text }, splitLine: { lineStyle: { color: cssVar("--chart-split", "#212836") } } },
      series: groups.map((g) => ({ name: g.name, type: "line", showSymbol: false, connectNulls: false, data: g.values,
        lineStyle: g.mean ? { width: 2.5, color: ink } : { width: 1.2, opacity: 0.6 },
        itemStyle: g.mean ? { color: ink } : undefined, z: g.mean ? 5 : 2,
        emphasis: { focus: "series", lineStyle: { width: g.mean ? 3 : 2.5, opacity: 1 } } })),
    });
    GM.onResize(chart);
    return chart;
  }

  async function drawSeries(host, w) {
    const grid = el("div", { class: "grid2 pai-charts" });
    const boxes = {};
    const charts = [["compute", t("计算利用率 %", "Compute %"), ["compute"]], ["memory", t("显存使用率 %", "GPU memory %"), ["memory"]],
      ["host", t("CPU / 内存利用率 %（占 Pod limit）", "CPU / RAM % of pod limit"), ["cpu", "ram"]]];
    for (const [key, title] of charts) {
      boxes[key] = el("div", { class: "pai-chart-box" }, [el("h3", {}, [title]), el("div", { class: "pai-chart-slot" }, [note(t("加载中…", "Loading…"))])]);
      grid.appendChild(boxes[key]);
    }
    host.appendChild(panel(t("最近 1 小时", "Last hour"), [
      note(t("云监控 60 秒源点按 120 秒桶取均值；缺测留空，不连线。曲线保持任务 / Pod / GPU 原始维度，不回推物理节点。",
        "60s source points averaged into 120s buckets; gaps stay empty. Series keep workload / Pod / GPU dimensions.")),
      grid,
    ]));
    let data;
    try { data = await API.paiSeries(w.WorkloadId); } catch (e) {
      if (!host.isConnected) return;
      PageRecovery.show();
      Object.values(boxes).forEach((b) => b.lastChild.replaceChildren(note(t("曲线读取失败", "Failed to load series"))));
      return;
    }
    if (!host.isConnected) return;
    const pods = [...new Set(data.points.map((p) => p.pod))];
    for (const [key, , metrics] of charts) {
      const slot = boxes[key].lastChild;
      const rows = data.points.filter((p) => metrics.includes(p.metric));
      if (!rows.length) { slot.replaceChildren(note(t("暂无指标", "No metrics"))); continue; }
      const groups = new Map();
      rows.forEach((p) => { if (!groups.has(p.series_id)) groups.set(p.series_id, []); groups.get(p.series_id).push(p); });
      const series = [...groups.values()].sort((a, b) => a[0].pod.localeCompare(b[0].pod)
        || a[0].gpu.localeCompare(b[0].gpu, undefined, { numeric: true })).map((points) => {
        points.sort((a, b) => a.ts - b.ts);
        const values = [];
        points.forEach((p, i) => {
          if (i && p.ts - points[i - 1].ts > 120) values.push([(points[i - 1].ts + 120) * 1000, null]);
          values.push([p.ts * 1000, p.mean]);
        });
        const label = key === "host" ? (points[0].metric === "cpu" ? "CPU" : t("内存", "RAM")) : "GPU " + points[0].gpu;
        return { name: (pods.length > 1 ? `P${pods.indexOf(points[0].pod) + 1}·` : "") + label, values };
      });
      // 均值线：同一时间桶内有值的卡取平均，缺测卡不计 0；只有一张卡时不重复画。
      if (key !== "host" && series.length > 1) {
        const buckets = new Map();
        series.forEach((g) => g.values.forEach(([ts, v]) => {
          if (v == null) return;
          const b = buckets.get(ts) || []; b.push(v); buckets.set(ts, b);
        }));
        const values = [...buckets].sort((a, b) => a[0] - b[0]).map(([ts, vs]) => [ts, vs.reduce((a, v) => a + v, 0) / vs.length]);
        const gapped = [];
        values.forEach((v, i) => { if (i && v[0] - values[i - 1][0] > 120000) gapped.push([values[i - 1][0] + 120000, null]); gapped.push(v); });
        series.push({ name: t("均值", "Mean"), values: gapped, mean: true });
      }
      const dom = el("div", { class: "chart pai-chart" });
      slot.replaceChildren(dom);
      seriesChart(dom, series);
    }
    if (data.truncated) grid.after(note(t("结果达到上限，部分曲线未展示。", "Result limit reached; some series are omitted.")));
  }

  // ── 排行：Feature / 用户。按小时历史汇总（最长 32 天），时间窗独立于裸金属 ─────
  // 维度切换只重绘本面板（数据已含两种维度）；切换时间窗才重新请求。
  const rankState = { window: "week", dimension: "feature", expanded: false, methodOpen: false };
  const RANK_PAGE = 30, RANK_FULL = 90, RANK_IDLE = 10;
  const rankNumber = (v) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const reportClock = (ts, zone = "Asia/Shanghai") => ts == null ? "—" : new Date(ts * 1000).toLocaleString("sv-SE", { timeZone: zone });
  const minuteClock = (ts, zone) => ts == null ? "—" : reportClock(ts, zone).slice(0, 16);
  const reportZone = (data) => data.timezone === "Asia/Shanghai" ? t("北京时间", "Asia/Shanghai") : data.timezone || "Asia/Shanghai";
  function weekRule(data) {
    const days = { monday: ["周一", "Monday"], tuesday: ["周二", "Tuesday"], wednesday: ["周三", "Wednesday"],
      thursday: ["周四", "Thursday"], friday: ["周五", "Friday"], saturday: ["周六", "Saturday"], sunday: ["周日", "Sunday"] };
    return `${reportZone(data)} ${t(...(days[data.week_start] || days.monday))} ${data.reset_time || "00:00"}`;
  }
  // GPU·小时等累计量：大数取整加千分位，小数保留一位。
  const hrs = (v) => v == null ? "—" : !v ? "0" : v >= 100 ? Math.round(v).toLocaleString() : Number(v).toFixed(1);
  // 覆盖率可能极小（上线首日约 0.02%），不能显示成 0.0%。
  const share = (v) => v == null ? "—" : v > 0 && v < 0.1 ? "<0.1%" : pct1(v);
  const span = (sec) => {
    const h = Math.floor(sec / 3600), d = Math.floor(h / 24);
    if (!d) return dur(sec);
    return h % 24 ? t(`${d} 天 ${h % 24} 小时`, `${d}d ${h % 24}h`) : t(`${d} 天`, `${d}d`);
  };
  function exportRanking(data, dimension) {
    const feature = dimension === "feature";
    const rows = feature ? data.features || [] : data.users || [];
    const fields = feature ? ["quota_id", "quota_name", "is_root", "gpu_hours", "quota_gpu_hours", "oversold_gpu_hours",
      "capacity_gpu_hours", "used_gpu_hours", "occupancy_pct", "observed_quota_hours", "quota_coverage_pct",
      "effective_gpu_hours", "measured_gpu_hours", "compute_mean", "gpu_memory_mean", "cpu_core_hours", "mem_gib_hours", "workloads",
      "current_capacity_gpu", "current_used_gpu", "current_occupancy_pct", "current_allocated_gpu", "current_borrowed_gpu", "quota_fresh"]
      : ["user_id", "username", "gpu_hours", "oversold_gpu_hours", "effective_gpu_hours", "measured_gpu_hours",
        "compute_mean", "gpu_memory_mean", "cpu_core_hours", "cpu_util_mean", "mem_gib_hours", "ram_util_mean", "workloads"];
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    const metadata = ["window", "timezone", "week_start", "reset_time", "since_local", "until_local", "generated_local", "history_first_hour_local", "truncated", "boundary_estimate"];
    const prefix = [data.window, data.timezone, data.week_start, data.reset_time, ...[data.since, data.until, data.generated_at, data.first_hour].map(ts => reportClock(ts, data.timezone)), data.truncated, data.boundary_estimate];
    const csv = [metadata.concat(fields), ...rows.map(r => prefix.concat(fields.map(k => r[k])))].map(r => r.map(cell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { href: url, download: `pai-${dimension}-${data.window}-${reportClock(data.until, data.timezone).slice(0, 10)}.csv` });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Feature 区分色：只用于用户排行里同一根用量条的分段。按 quota_id 排序分配，各时间窗颜色一致；
  // 色相避开利用率红橙、警示琥珀与闲时紫，饱和度压低；根配额直接提交和已删除的历史配额不是现有 feature，用中性灰。
  const FEATURE_HUES = [199, 152, 330, 222, 95, 178, 300, 128];
  function featureColors(data) {
    const light = document.body.dataset.theme === "light";
    const roots = new Set((data.features || []).filter((f) => f.is_root).map((f) => String(f.quota_id)));
    const gone = new Set((data.features || []).filter((f) => f.current_capacity_gpu == null && f.current_used_gpu == null).map((f) => String(f.quota_id)));
    const ids = [...new Set([...(data.features || []).map((f) => String(f.quota_id)),
      ...(data.users || []).flatMap((u) => (u.quotas || []).map((q) => String(q.quota_id)))])].filter((id) => !roots.has(id) && !gone.has(id)).sort();
    const n = FEATURE_HUES.length;
    const map = new Map(ids.map((id, i) => [id, `hsl(${(FEATURE_HUES[i % n] + 17 * Math.floor(i / n)) % 360}, ${light ? 52 : 48}%, ${light ? 44 : 60}%)`]));
    return (id) => (roots.has(String(id)) ? "var(--muted)" : map.get(String(id)) || "var(--faint)");
  }

  // 横向用量条：实色为配额内（用户排行按 feature 分色），斜纹紫为闲时资源；长度按本榜最大值归一。
  function usageBar(parts, max) {
    return el("div", { class: "pai-rank-bar" }, parts.filter((p) => p.v > 0).map((p) => el("i", {
      class: p.idle ? "idle" : null, title: p.title || null,
      style: `width:${Math.max(0.8, p.v / max * 100)}%` + (p.color ? `;--c:${p.color}` : "") })));
  }
  function usageCell(total, idle, parts, max, sum) {
    if (total == null) return el("span", { class: "pai-dash", title: t("该窗口无任务历史", "No task history in this window") }, ["—"]);
    return el("div", { class: "pai-rank-usage" }, [
      el("div", { class: "pai-rank-usage-top" }, [
        el("b", {}, [hrs(total)]),
        idle > 0 ? el("span", { class: "idle", title: OVERSOLD_TIP() }, [t(`闲时 ${hrs(idle)}`, `idle ${hrs(idle)}`)]) : null,
        sum > 0 ? el("span", { class: "share", title: t("占本窗口合计", "Share of the window total") }, [share(total / sum * 100)]) : null,
      ]),
      usageBar(parts, max),
    ]);
  }
  // 读数 + 细条 + 次要说明。缺测显示 "—"，不画成 0。
  function meterCell(v, opts) {
    opts = opts || {};
    const sub = opts.sub ? el("small", { class: opts.subTone || null }, [opts.sub]) : null;
    if (v == null) return el("div", { class: "pai-rank-meter none", title: opts.title || null }, [el("b", {}, [opts.text && opts.always ? opts.text : "—"]), sub]);
    return el("div", { class: "pai-rank-meter" + (opts.cls ? " " + opts.cls : ""), title: opts.title || null, style: opts.color ? `--m:${opts.color}` : null }, [
      el("b", {}, [opts.text || pct1(v)]),
      el("span", { class: "meter" }, [el("i", { style: `width:${Math.max(0, Math.min(100, v))}%` })]),
      sub,
    ]);
  }
  // 指标细条统一用强调色；只有“计算偏低”用琥珀色，与行内标签呼应。
  const computeCell = (mean, measured, effective, total) => meterCell(mean, {
    color: mean != null && mean < RANK_IDLE ? "var(--held)" : null, text: pct(mean),
    sub: measured ? t(`有效 ${hrs(effective)} GPU·h`, `${hrs(effective)} eff. GPU-h`) : null,
    title: total ? t(`指标覆盖 ${rankNumber(measured)} / ${rankNumber(total)} GPU·小时；有效 GPU·小时按单卡计算利用率加权`,
      `Metrics cover ${rankNumber(measured)} / ${rankNumber(total)} GPU-hours; effective GPU-hours are weighted by compute`) : null });
  // 没有任务历史时顺序没有意义，名次显示为 “—”。
  const rankBadge = (i, live, unknown) => el("span", { class: "pai-rank-no" + (i < 3 && live ? " top" : "") }, [unknown ? "—" : String(i + 1)]);
  const rankHead = (cols) => el("thead", {}, [el("tr", {}, cols.map(([label, cls, title]) =>
    el("th", { class: cls, scope: "col", title: title || null }, [label])))]);
  const rankTd = (cols) => (i, child) => el("td", { class: cols[i][1], "data-label": cols[i][0] }, [child]);

  // 只标两类值得周报关注的情况；阈值写在提示里，不替代原始数字。
  function rankFlags(r, quota) {
    const flags = [];
    if (quota && !r.is_root && r.occupancy_pct != null && r.occupancy_pct >= RANK_FULL) flags.push(el("span", { class: "pai-rank-flag full",
      title: t(`窗口配额占用率 ≥ ${RANK_FULL}%：配额基本用满，排队或闲时任务可能增多`, `Quota occupancy ≥ ${RANK_FULL}%: the quota is nearly saturated`) }, [t("接近满额", "Near full")]));
    if (r.gpu_hours > 0 && r.measured_gpu_hours > 0 && r.compute_mean != null && r.compute_mean < RANK_IDLE) flags.push(el("span", { class: "pai-rank-flag low",
      title: t(`计算均值 < ${RANK_IDLE}%：占着 GPU 但计算很少`, `Compute mean < ${RANK_IDLE}%: GPUs held with little compute`) }, [t("计算偏低", "Low compute")]));
    return flags;
  }

  function featureTable(data) {
    const rows = data.features || [];
    const sum = rows.reduce((a, r) => a + (r.gpu_hours || 0), 0);
    const max = Math.max(0, ...rows.map((r) => r.gpu_hours || 0)) || 1;
    const root = rows.find((r) => r.is_root);
    const cols = [["#", "c-rank"], ["Feature", "c-name"],
      [t("GPU·小时", "GPU-hours"), "c-usage", t("调度卡数 × 运行时长。实色为配额内，斜纹为闲时资源（配额外）；百分比为占本窗口合计", "Scheduled GPUs × running time. Solid is in-quota, hatched is idle-time capacity; % is the share of the window total")],
      [t("配额占用率", "Quota occupancy"), "c-metric", t("窗口内已观测配额用量 ÷ 同期配额容量（GPU·小时），不含闲时资源", "Observed quota usage ÷ capacity over the window (GPU-hours), excluding idle-time")],
      [t("计算均值", "Compute"), "c-metric", t("任务 GPU 计算利用率均值，缺测不计零", "Mean GPU compute utilization of workloads; missing metrics are not zero")],
      [t("当前用量 / 配额", "Now used / quota"), "c-metric", t("最新配额快照（卡），与所选时间窗无关", "Latest quota snapshot (GPUs), independent of the window")],
      [t("任务", "Jobs"), "c-jobs num"]];
    const td = rankTd(cols);
    return el("table", { class: "pai-rank-table feature" }, [rankHead(cols), el("tbody", {}, rows.map((r, i) => {
      const idle = r.oversold_gpu_hours || 0, cap = r.current_capacity_gpu;
      const inSnapshot = cap != null || r.current_used_gpu != null;
      // 各行覆盖率通常与资源池相同，只在明显不同的行单独提示。
      const ownCoverage = r.quota_coverage_pct != null && r.quota_coverage_pct < 99 &&
        (!root || Math.abs(r.quota_coverage_pct - (root.quota_coverage_pct || 0)) > 1);
      const occTitle = t(`已观测用量 ${rankNumber(r.used_gpu_hours)} / 容量 ${rankNumber(r.capacity_gpu_hours)} GPU·小时；观测 ${rankNumber(r.observed_quota_hours)} 小时，覆盖 ${share(r.quota_coverage_pct)}`,
        `Observed used ${rankNumber(r.used_gpu_hours)} / capacity ${rankNumber(r.capacity_gpu_hours)} GPU-hours; ${rankNumber(r.observed_quota_hours)} hours observed, ${share(r.quota_coverage_pct)} coverage`);
      const occSub = r.is_root ? t("资源池整体，含子配额", "Whole pool, incl. children")
        : ownCoverage ? t(`仅覆盖 ${share(r.quota_coverage_pct)}`, `${share(r.quota_coverage_pct)} covered`)
        : r.capacity_gpu_hours != null ? `${hrs(r.used_gpu_hours)} / ${hrs(r.capacity_gpu_hours)} GPU·h` : null;
      const now = !inSnapshot ? meterCell(null, { sub: t("不在当前配额列表", "Not in current quotas") })
        : meterCell(r.current_occupancy_pct, { text: `${gpus(r.current_used_gpu)} / ${gpus(cap)}`, always: true, cls: data.quota_fresh ? null : "stale",
          sub: data.quota_fresh ? (r.current_occupancy_pct == null ? null : t(`占用 ${pct1(r.current_occupancy_pct)}`, `${pct1(r.current_occupancy_pct)} used`)) : t("快照陈旧", "Stale snapshot"),
          subTone: data.quota_fresh ? null : "warn",
          title: t(`最新快照；资源上已分配 ${rankNumber(r.current_allocated_gpu)} 卡，其中祖先配额借用 ${rankNumber(r.current_borrowed_gpu)} 卡。资源被借用不等于本 feature 的任务用量。`,
            `Latest snapshot; ${rankNumber(r.current_allocated_gpu)} GPUs allocated, including ${rankNumber(r.current_borrowed_gpu)} used by ancestors. Borrowed capacity is not feature task usage.`) });
      return el("tr", { class: [r.is_root ? "root" : "", r.gpu_hours ? "" : "zero"].join(" ").trim() || null }, [
        td(0, rankBadge(i, r.gpu_hours > 0, r.gpu_hours == null)),
        td(1, el("div", { class: "pai-rank-name" }, [el("div", {}, [
          el("b", { title: r.quota_name }, [r.quota_name]),
          r.is_root ? el("small", {}, [t("根配额 · 直接提交", "Root quota · direct submissions")])
            : !inSnapshot ? el("small", {}, [t("历史配额，已不在当前列表", "Historical quota")]) : null]), ...rankFlags(r, true)])),
        td(2, usageCell(r.gpu_hours, idle, [{ v: (r.gpu_hours || 0) - idle, title: t(`配额内 ${hrs((r.gpu_hours || 0) - idle)} GPU·h`, `In quota ${hrs((r.gpu_hours || 0) - idle)} GPU-h`) },
          { v: idle, idle: true, title: t(`闲时资源 ${hrs(idle)} GPU·h`, `Idle-time ${hrs(idle)} GPU-h`) }], max, sum)),
        td(3, meterCell(r.occupancy_pct, { title: occTitle, sub: occSub, subTone: ownCoverage && r.quota_coverage_pct < 50 ? "warn" : null })),
        td(4, computeCell(r.compute_mean, r.measured_gpu_hours, r.effective_gpu_hours, r.gpu_hours)),
        td(5, now),
        td(6, r.workloads == null ? "—" : String(r.workloads)),
      ]);
    }))]);
  }

  function userTable(data, colorOf, rows) {
    const all = data.users || [];
    const sum = all.reduce((a, u) => a + (u.gpu_hours || 0), 0);
    const max = Math.max(0, ...all.map((u) => u.gpu_hours || 0)) || 1;
    const cols = [["#", "c-rank"], [t("用户", "User"), "c-name"],
      [t("GPU·小时", "GPU-hours"), "c-usage", t("调度卡数 × 运行时长。彩色分段按 feature，斜纹为闲时资源（配额外）；百分比为占本窗口合计", "Scheduled GPUs × running time, split by feature; hatched is idle-time capacity; % is the share of the window total")],
      [t("计算均值", "Compute"), "c-metric", t("任务 GPU 计算利用率均值，缺测不计零", "Mean GPU compute utilization; missing metrics are not zero")],
      [t("显存", "GPU memory"), "c-metric"],
      ["CPU", "c-metric", t("CPU 利用率（占 Pod limit）；下方为申请核数 × 时长", "CPU utilization of the Pod limit; below: requested cores × time")],
      [t("内存", "RAM"), "c-metric", t("内存利用率（占 Pod limit）；下方为申请量 × 时长", "RAM utilization of the Pod limit; below: requested GiB × time")],
      [t("任务", "Jobs"), "c-jobs num"]];
    const td = rankTd(cols);
    return el("table", { class: "pai-rank-table user" }, [rankHead(cols), el("tbody", {}, rows.map((u, i) => {
      // 接口按 (用户, 配额) 分组，每个配额只出现一次。
      const tags = (u.quotas || []).filter((q) => q.gpu_hours > 0 || q.oversold_gpu_hours > 0).sort((a, b) => b.gpu_hours - a.gpu_hours);
      const parts = tags.map((q) => ({ v: q.gpu_hours, color: colorOf(q.quota_id), title: `${q.quota_name} · ${hrs(q.gpu_hours)} GPU·h` }));
      parts.push({ v: u.oversold_gpu_hours, idle: true, title: t(`闲时资源 ${hrs(u.oversold_gpu_hours)} GPU·h`, `Idle-time ${hrs(u.oversold_gpu_hours)} GPU-h`) });
      return el("tr", { class: u.gpu_hours ? null : "zero" }, [
        td(0, rankBadge(i, u.gpu_hours > 0)),
        td(1, el("div", { class: "pai-rank-name" }, [el("div", {}, [
          link(u.username, href("user", u.user_id)),
          tags.length ? el("span", { class: "pai-rank-tags" }, [...tags.slice(0, 3).map((q) => el("span", { title: q.quota_name }, [
            el("i", { style: `--c:${colorOf(q.quota_id)}` }), q.quota_name])), tags.length > 3 ? el("span", {}, ["+" + (tags.length - 3)]) : null]) : null]), ...rankFlags(u, false)])),
        td(2, usageCell(u.gpu_hours, u.oversold_gpu_hours || 0, parts, max, sum)),
        td(3, computeCell(u.compute_mean, u.measured_gpu_hours, u.effective_gpu_hours, u.gpu_hours)),
        td(4, meterCell(u.gpu_memory_mean, { text: pct(u.gpu_memory_mean) })),
        td(5, meterCell(u.cpu_util_mean, { text: pct(u.cpu_util_mean), sub: t(`${hrs(u.cpu_core_hours)} 核·h`, `${hrs(u.cpu_core_hours)} core-h`) })),
        td(6, meterCell(u.ram_util_mean, { text: pct(u.ram_util_mean), sub: `${hrs(u.mem_gib_hours)} GiB·h` })),
        td(7, String(u.workloads ?? "—")),
      ]);
    }))]);
  }

  // 本窗口汇总：两种维度共用。资源池口径取根配额（容量含全部子配额）。
  function rankSummary(data) {
    const fs = data.features || [];
    const root = fs.find((f) => f.is_root);
    const known = fs.some((f) => f.gpu_hours != null);
    const add = (k) => fs.reduce((a, f) => a + (f[k] || 0), 0);
    const total = known ? add("gpu_hours") : null, idle = add("oversold_gpu_hours");
    const measured = add("measured_gpu_hours"), effective = add("effective_gpu_hours");
    const users = (data.users || []).filter((u) => u.gpu_hours > 0).length;
    const stat = (label, value, subs, extra, cls) => el("div", { class: "pai-rank-stat" + (cls ? " " + cls : "") }, [
      el("span", {}, [label]), el("b", {}, [value]), extra || null, ...subs.filter(Boolean)]);
    const small = (text, tone) => el("small", { class: tone || null }, [text]);
    const meter = (v) => v == null ? null : el("span", { class: "meter" }, [el("i", { style: `width:${Math.max(0, Math.min(100, v))}%` })]);
    const cover = root ? root.quota_coverage_pct : null;
    return el("div", { class: "pai-rank-stats" }, [
      stat(t("GPU·小时合计", "Total GPU-hours"), hrs(total), [total == null ? small(t("该窗口无任务历史", "No task history in this window"))
        : small(t(`配额内 ${hrs(total - idle)} · 闲时 ${hrs(idle)}`, `${hrs(total - idle)} in quota · ${hrs(idle)} idle-time`))],
        total ? usageBar([{ v: total - idle, color: "var(--accent)" }, { v: idle, idle: true }], total) : null, "total"),
      stat(t("资源池配额占用率", "Pool quota occupancy"), root ? pct1(root.occupancy_pct) : "—", [
        root && root.capacity_gpu_hours != null ? small(`${hrs(root.used_gpu_hours)} / ${hrs(root.capacity_gpu_hours)} GPU·h`) : null,
        cover != null ? small(t(`配额历史覆盖 ${share(cover)}`, `${share(cover)} of window observed`), cover < 95 ? "warn" : null) : null], meter(root?.occupancy_pct)),
      stat(t("有效 GPU·小时", "Effective GPU-hours"), measured ? hrs(effective) : "—", [measured
        ? small(t(`按 GPU·小时加权的计算均值 ${pct(effective / measured * 100)}`, `GPU-hour weighted compute ${pct(effective / measured * 100)}`))
        : small(t("暂无计算指标", "No compute metrics yet"))]),
      stat(t("当前资源池", "Pool now"), root && root.current_capacity_gpu != null ? `${gpus(root.current_used_gpu)} / ${gpus(root.current_capacity_gpu)}` : "—", [
        data.quota_fresh ? small(t(`占用 ${pct1(root?.current_occupancy_pct)} · 最新快照`, `${pct1(root?.current_occupancy_pct)} used · latest snapshot`))
          : small(t("快照陈旧或采集失败", "Snapshot stale or failed"), "warn")], meter(root?.current_occupancy_pct), data.quota_fresh ? null : "stale"),
      stat(t("活跃 feature", "Active features"), known ? String(fs.filter((f) => !f.is_root && f.gpu_hours > 0).length) : "—", [
        known ? small(`${plural(users, "位用户", "user")} · ${plural(add("workloads"), "个任务", "job")}`) : null]),
    ]);
  }

  function rankNotices(data) {
    const root = (data.features || []).find((f) => f.is_root);
    const out = [];
    if (data.first_hour == null || data.first_hour >= data.until) out.push(["warn", t("该窗口尚无任务观测历史，任务用量显示为“—”，不代表零使用。", "No task history was observed in this window; usage shows “—”, not zero.")]);
    if (rankState.dimension === "feature" && root && !root.quota_coverage_pct) out.push(["", t("该窗口没有配额历史，配额占用率未知。", "No quota history in this window; occupancy is unknown.")]);
    if (!data.quota_fresh) out.push(["warn", t("当前配额快照陈旧或采集失败，“当前”数值仅供参考。", "The current quota snapshot is stale or failed; current values are for reference only.")]);
    if (data.truncated) out.push(["warn", t("结果达到上限，表格与导出只含已返回的数据。", "Results are truncated; the table and export contain only returned rows.")]);
    return out.length ? el("div", { class: "pai-rank-notices" }, out.map(([tone, text]) => note(text, "pai-note " + tone))) : null;
  }

  function rankMethod(dimension, data) {
    const items = dimension === "feature" ? [
      t("按任务提交时的 Quota 归属 feature；根配额直接提交的任务单列，不推断算法组。父子配额容量不可相加。", "Workloads follow their submission Quota. Direct root submissions stay separate; parent and child capacities must not be added."),
      t("GPU·小时 = 调度卡数 × 采集器观测到的运行时长（每轮约 2 分钟，长间隔最多计两倍降级周期，失败快照不累加）。闲时资源单列，不计入配额。", "GPU-hours = scheduled GPUs × observed running time (≈2-min rounds, long gaps capped, failed snapshots add nothing). Idle-time capacity is separate from the quota."),
      t("配额占用率 = 已观测配额用量 GPU·小时 ÷ 同期配额容量 GPU·小时，不含闲时资源；配额变更按观测时长加权。根配额的用量含全部子配额，而它的任务小时只含直接提交。", "Quota occupancy = observed used GPU-hours ÷ capacity GPU-hours over the same intervals, excluding idle-time; changes are time-weighted. Root usage includes children, root task hours only direct submissions."),
      t("配额历史从启用该统计起积累，任务 GPU·小时沿用已有历史，两者覆盖区间可能不同。", "Quota history starts when this report was enabled; task-hour history can be longer."),
      t("计算均值为任务计算利用率均值，缺测不计零；有效 GPU·小时按单卡计算利用率加权。“当前用量 / 配额”是最新快照。", "Compute is the mean workload utilization, missing metrics are unknown; effective GPU-hours are compute-weighted. “Now” is the latest snapshot."),
    ] : [
      t("归属为任务提交者（RAM Owner），不代表共享容器内的逐进程使用人。", "Attribution is the submitter (RAM owner), not processes inside shared containers."),
      t("GPU·小时 = 调度卡数 × 采集器观测到的运行时长；彩色分段按任务所属 feature，斜纹为闲时资源（配额外）。", "GPU-hours = scheduled GPUs × observed running time; colored segments follow the workload's feature, hatched is idle-time capacity."),
      t("有效 GPU·小时按单卡计算利用率加权；CPU、内存为申请量 × 时长，利用率为占 Pod limit 的百分比。缺测不计零。", "Effective GPU-hours are compute-weighted; CPU and RAM are requested amounts × time, utilization is relative to the Pod limit. Missing metrics are unknown."),
    ];
    items.push(t(`每周起点：${weekRule(data)}。历史按 UTC 小时汇总，保留 32 天；周界未对齐 UTC 整点时，边界小时按重叠时长估算。CSV 包含时区、周界、分母和覆盖率。`,
      `Weeks start ${weekRule(data)}. History uses UTC-hour buckets, kept for 32 days; partial boundary hours are estimated by overlap. CSV includes timezone, week rule, denominators and coverage.`));
    return el("details", { class: "pai-rank-method", open: rankState.methodOpen ? "" : null,
      ontoggle: (e) => { rankState.methodOpen = e.target.open; } }, [
      el("summary", {}, [t("统计口径", "How it is computed")]),
      el("ul", {}, items.map((x) => el("li", {}, [x]))),
      el("div", { class: "pai-docs" }, [doc("quota", t("资源配额", "Resource quotas")), doc("idle")]),
    ]);
  }

  function rankLegend(data, colorOf) {
    const items = [];
    if (rankState.dimension === "user") {
      const seen = new Map();
      (data.users || []).forEach((u) => (u.quotas || []).forEach((q) => { if (q.gpu_hours > 0 && !seen.has(q.quota_id)) seen.set(q.quota_id, q.quota_name); }));
      [...seen].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).forEach(([id, name]) => items.push(el("span", { class: "feature" }, [el("i", { style: `--c:${colorOf(id)}` }), name])));
    } else items.push(el("span", {}, [el("i", {}), t("配额内", "In quota")]));
    items.push(el("span", { title: OVERSOLD_TIP() }, [el("i", { class: "idle" }), t("闲时资源（配额外）", "Idle-time (outside quota)")]));
    items.push(el("span", { class: "sort" }, [t("按 GPU·小时降序", "Sorted by GPU-hours")]));
    return el("div", { class: "pai-rank-legend" }, items);
  }

  function rankContent(data, failed, redraw) {
    const dim = rankState.dimension, w = rankState.window;
    const rolling = !["week", "last_week"].includes(w);
    const segButton = (key, label, pressed, onclick, attr) => el("button", { type: "button", class: pressed ? "active" : null,
      "aria-pressed": String(pressed), [attr]: key, onclick }, [label]);
    const setWindow = (key) => { if (key && key !== rankState.window) { rankState.window = key; rankState.expanded = false; GM.render({ soft: true }); } };
    const controls = el("div", { class: "pai-tools pai-rank-controls" }, [
      el("div", { class: "pai-seg", role: "group", "aria-label": t("排行维度", "Ranking dimension") }, [["feature", "Feature"], ["user", t("用户", "User")]].map(([key, label]) =>
        segButton(key, label, dim === key, () => {
          if (rankState.dimension === key) return;
          rankState.dimension = key; rankState.expanded = false; redraw();
          document.querySelector(`.pai-rank [data-dim="${key}"]`)?.focus();
        }, "data-dim"))),
      el("div", { class: "pai-seg period", role: "group", "aria-label": t("统计周期", "Reporting period") }, [
        segButton("week", t("本周", "This week"), w === "week", () => setWindow("week"), "data-win"),
        segButton("last_week", t("上周", "Last week"), w === "last_week", () => setWindow("last_week"), "data-win"),
        el("select", { class: "pai-rank-roll" + (rolling ? " active" : ""), "aria-label": t("滚动时间窗", "Rolling window"),
          onchange: (e) => setWindow(e.target.value) }, [
          el("option", { value: "", selected: rolling ? null : "selected", disabled: "disabled" }, [t("滚动窗口", "Rolling")]),
          ...GM.state.meta.windows.map((k) => el("option", { value: k, selected: w === k ? "selected" : null }, [t(`近 ${k}`, `Last ${k}`)]))]),
      ]),
      data ? el("button", { type: "button", class: "pai-rank-export", onclick: () => exportRanking(data, rankState.dimension),
        title: t("导出当前维度与时间窗的 CSV（含分母与覆盖率）", "Export this view as CSV, with denominators and coverage") },
        [el("span", { "aria-hidden": "true" }, ["↓"]), t("导出 CSV", "Export CSV")]) : null,
    ]);
    const range = data ? el("div", { class: "pai-rank-range" }, [
      el("span", { class: "mono" }, [`${minuteClock(data.since, data.timezone)} → ${minuteClock(data.until, data.timezone)}`]),
      el("span", {}, [reportZone(data) + " · " + span(data.until - data.since) + (w === "week" ? t(" · 进行中", " · in progress") : "")]),
    ]) : el("div", { class: "pai-rank-range" }, [t("读取中…", "Loading…")]);
    const head = el("div", { class: "pai-panel-head pai-rank-head" }, [
      el("div", { class: "pai-rank-heading" }, [el("h3", {}, [dim === "feature" ? t("Feature 排行", "Feature ranking") : t("用户排行", "User ranking")]), range]),
      controls]);
    if (failed) return [head, note(t("排行读取失败", "Failed to load ranking"))];
    if (!data) return [head];
    const colorOf = featureColors(data);
    const rows = dim === "feature" ? data.features || [] : data.users || [];
    const body = [rankSummary(data), rankNotices(data)];
    if (!rows.length) body.push(el("div", { class: "pai-rank-empty" }, [t("该时间窗内还没有记录。", "No records in this window yet.")]));
    else {
      const shown = dim === "user" && !rankState.expanded ? rows.slice(0, RANK_PAGE) : rows;
      const known = rows.some((r) => r.gpu_hours != null);
      body.push(known ? rankLegend(data, colorOf) : null, el("div", { class: "pai-rank-scroll" }, [
        dim === "feature" ? featureTable(data) : userTable(data, colorOf, shown)]));
      if (shown.length < rows.length) body.push(el("button", { type: "button", class: "pai-rank-more",
        onclick: () => { rankState.expanded = true; redraw(); } }, [t(`显示全部 ${rows.length} 位用户`, `Show all ${rows.length} users`)]));
    }
    body.push(rankMethod(dim, data));
    return [head, ...body.filter(Boolean)];
  }

  async function rankingPanel(host) {
    const box = el("section", { class: "panel pai-panel pai-rank" });
    let data = null, failed = false;
    const draw = () => box.replaceChildren(...rankContent(data, failed, draw));
    draw();
    host.appendChild(box);
    try { data = await API.paiRanking(rankState.window); } catch (e) {
      if (!host.isConnected) return;
      PageRecovery.show();
      failed = true; draw();
      return;
    }
    if (!host.isConnected) return;
    draw();
  }

  function metaList(items) {
    return el("dl", { class: "pai-meta" }, items.filter(Boolean).flatMap(([k, v]) => [el("dt", {}, [k]), el("dd", {}, [v])]));
  }

  function miniMetrics(items) {
    return el("div", { class: "pai-mini" }, items.map(([k, v]) => el("div", { class: "mini-metric" }, [el("span", {}, [k]), el("b", {}, [v])])));
  }

  return { el, t, ui, LOW, isLow, num, pct, pct1, gpus, ago, clock, href, link, note, chip, typeChip, bar, prepare, cell, card, legend,
    header, slimHeader, kpis, taskMeanHint, clusterMeanHint, tabs, panel, back, heatPanel, nodesPanel, workloadsPanel, workloadsTable, usersTable, quotasPanel,
    sourcesPanel, docsPanel, queueBanner, healText, rankingPanel, strategyText, specText, dur, doc, oversoldChip, stateCell, nodeChips, OVERSOLD_TIP, drawSeries, metaList, miniMetrics, rangeText, conflictFlag };
})();

// ── 首页：两个平台入口，各自显示来源新鲜度，不合并统计 ─────────────
Views.home = { async render(root) {
  const { el, t, note, chip, pct, ago } = PaiUI;
  GM.crumb(t("首页", "Home"));
  const stat = (k, v, hint) => el("div", { class: "mini-metric", title: hint || null }, [el("span", {}, [k]), el("b", {}, [v])]);
  const shell = (cls, eyebrow, title, desc, path, go) => {
    const body = el("div", { class: "home-body" }, [note(t("读取中…", "Loading…"))]);
    const status = el("div", { class: "home-status" });
    const card = el("a", { class: "home-card " + cls, href: "#" + path }, [
      el("div", { class: "home-card-head" }, [el("div", {}, [el("div", { class: "eyebrow" }, [eyebrow]), el("h2", {}, [title]), note(desc)]), status]),
      body,
      el("div", { class: "home-foot" }, [el("span", { class: "home-go" }, [go])]),
    ]);
    return { card, body, status };
  };
  root.appendChild(el("section", { class: "home-head" }, [
    el("div", { class: "eyebrow" }, ["GPU MONITOR"]),
    el("h1", {}, [t("算力资源", "Compute resources")]),
    note(t("裸金属与 PAI 的用户身份和统计口径不同，分开展示，不合并计算。", "Bare-metal and PAI use different identities and accounting, so they are shown separately and never summed.")),
  ]));
  const pai = shell("pai-scope", "PAI", t("PAI 平台", "PAI platform"), t("配额 · 节点与单卡 · DSW / DLC 任务 · 用户", "Quotas · nodes & GPUs · DSW / DLC · users"), "/pai", t("进入 PAI →", "Open PAI →"));
  const bare = shell("bm", "BARE METAL", t("裸金属", "Bare metal"), t("主机 · 单卡 · 历史统计 · 用户排行", "Hosts · GPUs · history · user ranking"), "/baremetal", t("进入裸金属 →", "Open bare metal →"));
  root.appendChild(el("div", { class: "home-grid" }, [pai.card, bare.card]));
  const stripOf = (values) => el("div", { class: "home-strip" }, values.map((v) => el("i", {
    class: v === "free" ? "free" : v == null ? "none" : "", style: typeof v === "number" ? `--c:${UI.utilColor(v).bg}` : "" })));
  await Promise.allSettled([
    API.paiOverview().then((raw) => {
      if (!root.isConnected) return;
      if (!raw.nodes) { pai.status.replaceChildren(chip(raw.state)); pai.body.replaceChildren(note(t("暂无快照", "No snapshot yet"))); return; }
      const m = PaiUI.prepare(raw), s = m.sx;
      pai.status.replaceChildren(...[chip(m.state), el("small", {}, [ago(m.updatedAt)]),
        s.queued.length ? el("span", { class: "pai-chip " + (s.unschedulable.length ? "bad" : "warn") },
          [t(`排队 ${s.queued.length}`, `${s.queued.length} queued`) + (s.unschedulable.length ? t(`（${s.unschedulable.length} 可能排不上）`, ` (${s.unschedulable.length} at risk)`) : "")]) : null].filter(Boolean));
      GM.setSourceHealth("pai", m.state, m.updatedAt);
      pai.body.replaceChildren(
        el("div", { class: "home-stats" }, [
          stat(t("已分配 / 物理卡", "Allocated / physical"), `${m.summary.mapped_gpus ?? "—"} / ${s.physical}`),
          stat(t("集群占用", "Cluster utilization"), pct(m.summary.cluster_compute_mean), PaiUI.clusterMeanHint(m.summary)),
          stat(t("计算均值（任务）", "Compute mean (tasks)"), pct(m.summary.task_compute_mean), PaiUI.taskMeanHint(m.summary)),
          stat(t("运行任务", "Running"), String(s.running)),
        ]),
        stripOf(m.cardsFlat.map((c) => c.state === "free" ? "free" : c.compute ? c.compute.value : null)),
        note([t(`每格一张物理卡（${s.physical}）。`, `One square per physical GPU (${s.physical}). `),
          s.oversoldGpu ? t(`闲时任务申请 ${s.oversoldGpu} 卡，物理位置未确认，不计入图中卡数。`, `Idle-time tasks request ${s.oversoldGpu} GPUs. Their physical location is unconfirmed; this count is not added to the grid. `) : "",
          s.unmapped.length ? t(`${s.unmapped.length} 个配额内任务未关联到节点。`, `${s.unmapped.length} in-quota workloads lack node mapping.`) : ""].join("")),
      );
    }).catch(() => { if (root.isConnected) { PageRecovery.show(); pai.status.replaceChildren(chip("error")); pai.body.replaceChildren(note(t("PAI 快照读取失败", "Failed to read PAI snapshot"))); } }),
    API.overview(GM.state.window).then((ov) => {
      if (!root.isConnected) return;
      const s = ov.summary || {};
      const all = (ov.clusters || []).flatMap((c) => c.hosts || []).filter((h) => h.status !== "planned");
      const age = all.map((h) => h.last_ok_ts).filter(Boolean);
      const last = age.length ? Math.max(...age) : null;
      const online = s.hosts_online || 0;
      bare.status.replaceChildren(chip(online ? "ok" : "stale"), el("small", {}, [ago(last)]));
      bare.body.replaceChildren(
        el("div", { class: "home-stats" }, [
          stat(t("在线主机", "Online hosts"), `${online} / ${s.hosts_total ?? "—"}`),
          stat(t("在用 GPU", "Busy GPUs"), `${s.cards_busy ?? "—"} / ${s.cards_total ?? "—"}`),
          stat(t("瞬时利用率", "Utilization"), pct(s.util_now_avg)),
          stat(t(`${s.window || GM.state.window} 均值`, `${s.window || GM.state.window} avg`), pct(s.util_avg)),
        ]),
        stripOf(all.flatMap((h) => (h.gpus || []).map((g) => (h.online ? g.util_recent ?? null : null)))),
        GM.state.baremetalNotice ? el("div", { class: "pai-note" }, [GM.state.baremetalNotice]) : note(t("每格一张 GPU，颜色为近 10 分钟利用率。", "One square per GPU, colored by 10-minute utilization.")),
      );
    }).catch(() => { if (root.isConnected) { PageRecovery.show(); bare.status.replaceChildren(chip("error")); bare.body.replaceChildren(note(t("裸金属数据读取失败", "Failed to read bare-metal data"))); } }),
  ]);
}};

// ── PAI 模块 ───────────────────────────────────────────────
Views.pai = { async render(root, params) {
  const P = PaiUI;
  const { el, t, note, chip, href } = P;
  const tabName = { overview: t("总览", "Overview"), nodes: t("节点", "Nodes"), workloads: t("任务", "Workloads"), users: t("用户", "Users"), ranking: t("排行", "Ranking") };
  GM.crumb(tabName[params.tab] || "PAI");
  const raw = await API.paiOverview();
  if (!root.isConnected) return;
  root.classList.add("pai-scope");
  if (!raw.nodes) {
    GM.setSourceHealth("pai", raw.state, null);
    root.appendChild(el("section", { class: "panel pai-empty-state" }, [el("h3", {}, ["PAI"]), chip(raw.state),
      note(raw.state === "waiting" ? t("采集器尚未完成首轮采集。", "The collector has not finished its first round.") : t("PAI 模块未启用。", "The PAI module is disabled."))]));
    return;
  }
  const m = P.prepare(raw);
  GM.setSourceHealth("pai", m.state, m.updatedAt);
  const tab = params.tab || "overview";
  const activeTab = { node: "nodes", workload: "workloads", user: "users" }[tab] || tab;
  // 排行页与裸金属排行一致：左上角“返回总览”。
  if (tab === "ranking") root.appendChild(P.back(t("返回总览", "Back to overview"), "#/pai"));
  if (tab === "overview") {
    root.appendChild(P.header(m));
    root.appendChild(P.kpis(m));
  } else root.appendChild(P.slimHeader(m));
  const queue = P.queueBanner(m);
  if (queue) root.appendChild(queue);
  if (m.state !== "ok") root.appendChild(el("div", { class: "pai-note warn" }, [t(
    "部分来源陈旧或采集失败。页面保留最近成功值并标注陈旧，请结合底部来源时间判断。",
    "Some sources are stale or failed. Last good values are kept and marked stale; check source times below.")]));
  root.appendChild(P.tabs(m, activeTab));

  if (tab === "overview") {
    root.appendChild(P.heatPanel(m));
    root.appendChild(el("div", { class: "grid2 pai-grid2" }, [
      P.panel(t("用户", "Users"), [P.usersTable(m.users, true)], { tools: P.link(t("详情 →", "Details →"), href("users"), "pai-more") }),
      P.quotasPanel(m),
    ]));
    root.appendChild(P.workloadsPanel(m, { limit: 8 }));
  } else if (tab === "ranking") {
    await P.rankingPanel(root);
    if (!root.isConnected) return;
  } else if (tab === "nodes") {
    root.appendChild(P.nodesPanel(m));
  } else if (tab === "node") {
    const n = m.nodes.find((x) => x.NodeName === params.id);
    if (!n) root.appendChild(P.panel(t("节点未找到", "Node not found"), [P.back(t("节点列表", "Nodes"), href("nodes"))]));
    else {
      GM.crumb(t("节点 › ", "Nodes › ") + n.short);
      const byId = Object.fromEntries(m.workloads.map((w) => [w.WorkloadId, w]));
      const rows = n.cards.flatMap((c) => (c.assignments.length ? c.assignments : [null]).map((a) => [c, a]));
      root.appendChild(P.back(t("节点列表", "Nodes"), href("nodes")));
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [el("h2", { class: "mono" }, [n.short]), ...P.nodeChips(n)]),
        P.metaList([[t("完整名称", "Full name"), el("span", { class: "mono" }, [n.NodeName])], [t("型号", "Model"), `${n.GPUType || "—"} · ${P.gpus(n.GPU)} GPU`],
          [t("所属配额", "Quota"), n.quotaNames.length ? n.quotaNames.join(", ") : "—"],
          [t("可分配 / 已请求", "Allocatable / requested"), `${P.gpus(n.AllocatableGPU)} / ${P.gpus(n.RequestGPU)}`],
          [t("节点状态", "Node state"), el("span", { class: "pai-inline" }, [chip(n.NodeStatus),
            n.healthPct != null ? el("span", {}, [t("健康度 ", "Health ") + Math.round(n.healthPct) + "%"]) : null,
            n.ReasonCode ? el("span", { class: "mono" }, [n.ReasonCode + (n.ReasonMessage ? " · " + n.ReasonMessage : "")]) : null,
            n.unhealthy || n.NodeStatus !== "Ready" ? P.doc("manageQuota", t("节点状态说明", "Node states")) : null,
            n.unhealthy ? P.doc("selfHeal") : null])],
          [t("Pod 映射", "Pod mapping"), chip(n.mapping_state)], [t("未见占用的卡", "No visible allocation"), String(n.free)]]),
        ...n.healTasks.map((w) => el("div", { class: "pai-note warn" }, [P.healText(n, w), " ", P.link(t("查看任务", "Open workload"), href("workload", w.WorkloadId)), " ", P.doc("selfHeal")])),
        P.legend(),
        el("div", { class: "cards pai-cards-lg" }, n.cards.map((c) => P.card(c, { href: c.assignments[0] ? href("workload", c.assignments[0].workload_id) : null }))),
      ]));
      root.appendChild(P.panel(t("单卡归属", "Card assignments"), [el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table compact" }, [
        el("thead", {}, [el("tr", {}, ["GPU", t("任务", "Workload"), "Owner", t("计算", "Compute"), t("显存", "Memory"), t("源采样", "Sampled")].map((h) => el("th", {}, [h])))]),
        el("tbody", {}, rows.map(([c, a]) => {
          const w = a && byId[a.workload_id];
          return el("tr", {}, [
            el("td", { "data-label": "GPU", class: "mono" }, ["#" + c.index]),
            el("td", { "data-label": t("任务", "Workload") }, [a ? P.link(w?.WorkloadName || a.workload_id, href("workload", a.workload_id)) : el("span", { class: "pai-muted" }, [c.state === "free" ? t("未分配", "Unallocated") : t("未知", "Unknown")]),
              a && !a.fresh ? el("small", { class: "pai-low" }, [t(" 上次关联", " last seen")]) : null]),
            el("td", { "data-label": "Owner" }, [a ? P.link(a.owner_name, href("user", a.owner_id)) : "—"]),
            el("td", { "data-label": t("计算", "Compute") }, [P.bar(c.compute?.value)]),
            el("td", { "data-label": t("显存", "Memory") }, [P.bar(c.memory?.value, { memory: true })]),
            el("td", { "data-label": t("源采样", "Sampled") }, [c.compute ? P.clock(c.compute.sampled_at) : "—"]),
          ]);
        })),
      ])])]));
    }
  } else if (tab === "users") {
    root.appendChild(P.panel(t("用户资源", "User resources"), [
      el("div", { class: "pai-note" }, [t("归属为 RAM Owner / 提交者，不代表共享容器内的逐进程使用人。申请 GPU 为任务逻辑量；Quota 用量来自配额接口，二者可能不一致。",
        "Attribution is the RAM owner / submitter, not processes inside shared containers. Requested GPU is logical; quota usage comes from the quota API and may differ.")]),
      P.usersTable(m.users, false)]));
  } else if (tab === "user") {
    const u = m.users.find((x) => x.UserId === params.id);
    root.appendChild(P.back(t("用户列表", "Users"), href("users")));
    if (!u) root.appendChild(P.panel(t("用户未找到", "User not found"), [note(t("该用户不在当前快照中。", "This user is not in the current snapshot."))]));
    else {
      GM.crumb(t("用户 › ", "Users › ") + u.Username);
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [el("h2", {}, [u.Username]), P.conflictFlag(u)]),
        P.miniMetrics([[t("运行任务", "Running"), P.gpus(u.running_workloads)], [t("申请 GPU", "Requested GPU"), P.gpus(u.submitted_gpu)],
          [t("配额统计用量", "Quota-counted usage"), P.gpus(u.used_gpu)], [t("已映射物理卡", "Mapped GPUs"), String(u.mapped)],
          [t("闲时资源 GPU", "Idle-time GPUs"), P.gpus(u.oversoldGpu)],
          [t("计算均值", "Compute"), P.pct(u.compute)], [t("显存均值", "Memory"), P.pct(u.memory)], [t(`计算<${P.LOW}% 卡`, `GPUs <${P.LOW}%`), String(u.low)]]),
        u.oversoldGpu ? el("div", { class: "pai-note oversold" }, [t(
          `其中 ${P.gpus(u.oversoldGpu)} 卡跑在闲时资源上，不计入配额统计用量，所以配额统计用量可能小于申请量；这不代表实际只用了这么多卡。`,
          `${P.gpus(u.oversoldGpu)} GPUs run on idle-time resources and are not counted in quota usage. `), P.doc("idle")]) : null,
        u.conflict ? el("div", { class: "pai-note warn" }, [t("Quota 用量为 0，但该用户仍有申请 GPU 的运行任务。来源口径不一致，页面不把该用户视为未使用。",
          "Quota usage is 0 while this user has running GPU workloads. The sources disagree; the user is not treated as idle.")]) : null,
      ]));
      root.appendChild(P.panel(t("任务", "Workloads"), [P.workloadsTable(u.workloads, { static: true, hideOwner: true })]));
    }
  } else if (tab === "workload") {
    const w = m.workloads.find((x) => x.WorkloadId === params.id);
    root.appendChild(P.back(t("任务列表", "Workloads"), href("workloads")));
    if (!w) root.appendChild(P.panel(t("任务未找到", "Workload not found"), [note(t("任务不存在或已离开活跃列表。", "Missing or no longer active."))]));
    else {
      GM.crumb(t("任务 › ", "Workloads › ") + w.WorkloadName);
      const pods = [...new Set(w.gpus.map((g) => g.pod))];
      const dimCard = (g) => ({ index: g.gpu, assignments: [], state: g.compute ? "measured" : "assigned",
        compute: g.compute && { value: g.compute.value, sampled_at: g.compute.ts, fresh: g.compute.fresh, recent: g.compute.recent_mean, recent_n: g.compute.recent_n },
        memory: g.memory && { value: g.memory.value, sampled_at: g.memory.ts, fresh: g.memory.fresh },
        stale: !!(g.compute && !g.compute.fresh), low: P.isLow(g.compute) });
      const scheduled = P.num(w.scheduled_gpu), requested = P.num(w.requested_gpu);
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [P.typeChip(w.WorkloadType), el("h2", {}, [w.WorkloadName]), P.stateCell(w), w.oversold ? P.oversoldChip() : null]),
        P.metaList([
          ["Owner", P.link(w.UserName, href("user", w.UserId))], [t("配额", "Quota"), w.quota],
          [t("申请 / 调度 GPU", "Requested / scheduled"), `${P.gpus(requested)} / ${P.gpus(scheduled)}`],
          [t("资源来源", "Capacity"), w.oversold
            ? el("span", { class: "pai-inline" }, [P.oversoldChip(t("闲时资源（配额外）", "Idle-time (outside quota)")),
              el("span", { class: "pai-muted" }, [t("不计入配额用量；原资源方需要时会被终止", "Not counted in quota usage; terminated when reclaimed")]), P.doc("idle")])
            : el("span", {}, [w.queued ? t("排队中，尚未分配", "Queued, not yet allocated") : t("配额内", "Inside the quota")])],
          [t("优先级", "Priority"), w.priority != null ? el("span", { class: "pai-inline" }, [String(w.priority), P.doc("preempt", t("抢占规则", "Preemption"))]) : "—"],
          w.WorkloadType === "dlc" ? [t("提交策略", "Idle-resource policy"), w.job
            ? el("span", { class: "pai-inline" }, [el("span", {}, [P.strategyText(w.strategy)]), P.doc("idle")])
            : el("span", { class: "pai-muted" }, [t("任务详情尚未取得", "Job detail not fetched yet")])] : null,
          w.WorkloadType === "dlc" && w.job ? [t("自动容错", "Fault tolerance"), el("span", { class: "pai-inline" }, [
            w.job.aimaster == null ? t("AIMaster 状态未知", "AIMaster unknown") : w.job.aimaster ? t("已开启 AIMaster", "AIMaster on") : t("未开启 AIMaster", "AIMaster off"),
            w.oversold && w.job.aimaster === false ? el("small", { class: "pai-low" }, [t("闲时资源被回收后平台不会自动重跑（业务脚本可能自带恢复）", "No platform auto-rerun after reclaim (scripts may recover)")]) : null])] : null,
          w.specs.length ? [t("Pod 规格", "Pod spec"), w.specs.map(P.specText).join("；")] : null,
          [t("CPU / 内存申请", "Requested CPU / RAM"), [w.requested_cpu != null ? t(`${P.gpus(w.requested_cpu)} 核`, `${P.gpus(w.requested_cpu)} cores`) : "—",
            w.requested_mem_gib != null ? `${P.gpus(Math.round(w.requested_mem_gib))} GiB` : "—"].join(" / ")],
          [t("物理节点", "Node"), w.nodes.length ? el("span", {}, w.nodes.flatMap((n, i) => [i ? ", " : null,
            P.link(n.short, href("node", n.name), "mono"), " · GPU " + P.rangeText(n.indices)]))
            : el("span", { class: "pai-muted" }, [w.oversold ? t("不公开（闲时任务不展示节点名）", "Hidden (idle-time workloads do not expose node names)")
              : w.metrics.length ? t("未关联（有单卡指标）", "Unmapped (has GPU metrics)") : "—"])],
          [t("任务 ID", "Workload ID"), el("span", { class: "mono" }, [w.WorkloadId])],
        ]),
        w.healNode ? el("div", { class: "pai-note warn" }, [P.healText(w.healNode, w), " ", P.doc("selfHeal")]) : null,
        w.queued ? el("div", { class: "pai-note " + (w.unschedulable ? "bad" : "warn") }, [
          t(`排队中${P.num(w.queue_position) ? `，第 ${w.queue_position} 位` : ""}${w.queuedFor != null ? `，已等 ${P.dur(w.queuedFor)}` : ""}。`,
            `Queued${P.num(w.queue_position) ? ` at #${w.queue_position}` : ""}${w.queuedFor != null ? `, waiting ${P.dur(w.queuedFor)}` : ""}. `),
          ...w.blockers.map((b) => el("div", {}, [b.text])), P.doc("schedule")]) : null,
        P.miniMetrics([...(w.gpus.length ? [[t("有近期值的卡", "GPUs with data"), `${w.measured} / ${w.gpus.length}`], [t("计算均值", "Compute"), P.pct(w.compute)],
          [t("显存均值", "GPU memory"), P.pct(w.memory)], [t(`计算<${P.LOW}%`, `<${P.LOW}%`), String(w.low)]] : []),
          [t("CPU 利用率", "CPU"), P.pct(w.cpu)], [t("内存利用率", "RAM"), P.pct(w.ram)]]),
      ]));
      if (w.gpus.length) {
        root.appendChild(P.panel(t("单卡当前值", "Current per-GPU values"), [
          ...pods.map((pod) => el("div", { class: "pai-pod" }, [
            pods.length > 1 || w.WorkloadType === "dlc" ? el("div", { class: "pai-pod-name mono" }, [`P${pods.indexOf(pod) + 1} · ${pod}`]) : null,
            el("div", { class: "cards pai-cards-lg" }, w.gpus.filter((g) => g.pod === pod).map((g) => P.card(dimCard(g), { index: g.gpu, label: `${pod} / GPU ${g.gpu}` }))),
          ])),
          note(t("任务内 GPU 编号来自云监控维度；仅当与 Pod 的物理 GPUIndexes 完全一致时才关联到物理卡。", "GPU numbers come from cloud-monitor dimensions; they map to physical cards only when they match the Pod's GPUIndexes exactly.")),
        ], { tools: P.legend() }));
      } else {
        root.appendChild(P.panel(t("单卡指标", "GPU metrics"), [note(requested ? t("源未返回该任务的单卡指标；保持未知，不计为 0%。", "No GPU metrics returned; kept unknown, not 0%.") : t("该任务未申请 GPU。", "This workload requests no GPUs."))]));
      }
      if (w.gpus.length || w.hostMetrics.length) {
        await P.drawSeries(root, w);
        if (!root.isConnected) return;
      }
      root.appendChild(el("details", { class: "panel pai-sources" }, [
        el("summary", {}, [t("源维度明细", "Source dimensions")]),
        el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table compact" }, [
          el("thead", {}, [el("tr", {}, ["Pod / GPU", t("指标", "Metric"), t("值", "Value"), t("源采样时间", "Sampled at")].map((h) => el("th", {}, [h])))]),
          el("tbody", {}, [...w.metrics, ...w.hostMetrics].map((x) => el("tr", {}, [
            el("td", { class: "mono", "data-label": "Pod / GPU" }, [x.pod + " / " + x.gpu]),
            el("td", { "data-label": t("指标", "Metric") }, [{ compute: t("计算", "Compute"), memory: t("显存", "GPU memory"), cpu: "CPU", ram: t("内存", "RAM") }[x.metric] || x.metric]),
            el("td", { "data-label": t("值", "Value") }, [P.pct1(x.value) + (x.fresh ? "" : t(" · 陈旧", " · stale"))]),
            el("td", { "data-label": t("源采样时间", "Sampled at") }, [P.clock(x.ts)]),
          ]))),
        ])]),
      ]));
    }
  } else {
    root.appendChild(P.workloadsPanel(m, { title: t("DSW / DLC 任务", "DSW / DLC workloads") }));
  }
  root.appendChild(P.docsPanel());
  root.appendChild(P.sourcesPanel(m));
}};
