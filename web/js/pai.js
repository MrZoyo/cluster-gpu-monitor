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
  const ui = { type: "all", q: "", sort: "gpu", desc: true, nodes: "all", quota: "all", sourcesOpen: false, queueOpen: false };

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
  // 口径说明：默认折叠、逐条保留原文；与排行页的统计说明同一视觉，不与状态数据争抢层级。
  function methodDetails(items, opts) {
    opts = opts || {};
    return el("details", { class: "pai-method" + (opts.cls ? " " + opts.cls : "") }, [
      el("summary", {}, [opts.title || t("统计口径", "How it is computed")]),
      el("ul", {}, items.filter(Boolean).map((x) => el("li", {}, Array.isArray(x) ? x : [x]))),
    ]);
  }
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
  const OVERSOLD_TIP = () => t("闲时借用：任务临时使用自有资源池内其他 Quota 暂不需要的节点，不增加物理容量。已取得可信 Pod 映射时可查看借用任务、用户和物理 GPU；映射未确认的卡保持未知。原 Quota 优先，需要资源时借用任务暂停、释放资源并重新等待。提交配额的用量计数可能不含借用，但占用 GPU 时间包含借用。",
    "Idle borrowing uses temporarily unused capacity of other quotas in the owned pool without adding physical capacity. Trusted Pod mappings identify the borrowing workload, owner and physical GPUs; unconfirmed mappings stay unknown. The original quota has priority, and borrowers pause, release resources and requeue when reclaimed. Submission-quota counters may exclude borrowing; occupied GPU time includes it.");
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
    d.estimateInfo = window.PaiEstimate?.explain(d) || {
      available: num(d.summary?.pool_compute_estimate) != null,
      reasons: [{ code: "estimate_unavailable", labelZh: "当前快照未满足估算条件", labelEn: "The snapshot does not meet estimation requirements" }],
    };
    const names = d.nodes.map((n) => n.NodeName);
    const prefix = commonPrefix(names);
    const short = (name) => (prefix.length >= 6 && name.length - prefix.length >= 4 ? "…" + name.slice(prefix.length) : name);
    const quotas = Object.fromEntries((d.quotas || []).map((q) => [q.quota_id, q]));
    const unlocatedGpu = d.workloads.some(w => w.WorkloadStatus === "Running" && w.scheduled !== false &&
      (num(w.scheduled_gpu) ?? num(w.requested_gpu) ?? 0) > (w.cards || []).length);
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
      // 后端同时核对普通与闲时 Pod；明确的 free_known 优先，未确认借用不能覆盖它成为空闲。
      const canBeFree = n.free_known ?? (n.mapping_state === "ok" && requested != null && requested <= assigned && !unlocatedGpu && !n.possibly_borrowed);
      n.cards.forEach((c) => {
        c.nodeName = n.NodeName;
        c.possiblyBorrowed = !c.assignments.length && n.possibly_borrowed === true;
        c.borrowed = c.assignments.some((a) => a.borrowed === true);
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
    const gpuOf = (w) => num(w.scheduled_gpu) ?? num(w.requested_gpu) ?? 0;
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
        if (!w || w.oversold || a.borrowed === true || mine.has(w.QuotaId)) return;
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
    // 配额视图模型：树、绑定节点上的卡状态、子树任务与用户。父子配额容量不可相加；借用是占用的子集，不增加容量。
    const depthOf = (q, seen = 0) => (q.parent_quota_id && quotas[q.parent_quota_id] && seen < 8 ? 1 + depthOf(quotas[q.parent_quota_id], seen + 1) : 0);
    (d.quotas || []).forEach((q) => {
      q.isRoot = q.quota_id === d.quota_id || !q.parent_quota_id;
      q.parent = quotas[q.parent_quota_id] || null;
      q.children = childrenOf(q.quota_id);
      q.depth = depthOf(q);
      const mine = new Set(subtree(q.quota_id));
      q.boundNodes = q.isRoot ? d.nodes : d.nodes.filter((n) => n.quotaIds.includes(q.quota_id));
      // 任务与配额的关系：直接提交 / 子配额提交 / 父配额任务落在本配额节点 / 闲时借用本配额节点。
      q.relationOf = (w) => (w.QuotaId === q.quota_id ? "direct" : mine.has(w.QuotaId) ? "child" : w.oversold ? "borrowed" : "ancestor");
      // 绑定节点上的物理卡：本配额（含子配额）任务 / 父配额任务 / 被闲时借用 / 原配额空闲 / 未知。
      const cs = { self: 0, ancestor: 0, lent: 0, free: 0, unknown: 0, low: 0, total: 0, values: [] };
      const placed = new Set();
      q.boundNodes.forEach((n) => n.cards.forEach((c) => {
        cs.total += 1;
        if (!c.assignments.length) { cs[c.state === "free" ? "free" : "unknown"] += 1; return; }
        if (c.low) cs.low += 1;
        if (c.compute?.fresh) cs.values.push(c.compute.value);
        c.assignments.forEach((a) => placed.add(a.workload_id));
        const a = c.assignments[0], w = byId[a.workload_id];
        const rel = a.borrowed === true ? "borrowed" : w ? q.relationOf(w) : "ancestor";
        cs[rel === "borrowed" ? "lent" : rel === "ancestor" ? "ancestor" : "self"] += 1;
      }));
      q.cards = cs;
      q.nodeComputeMean = mean(cs.values);
      // 本配额的任务 = 提交到本配额（含子配额）的任务 ∪ 跑在本配额节点上的任务；每个任务只计一次。
      q.relation = new Map(d.workloads.filter((w) => placed.has(w.WorkloadId) || mine.has(w.QuotaId)).map((w) => [w.WorkloadId, q.relationOf(w)]));
      q.workloads = d.workloads.filter((w) => q.relation.has(w.WorkloadId));
      q.running = q.workloads.filter((w) => w.WorkloadStatus === "Running" && !w.queued);
      q.queued = q.workloads.filter((w) => w.queued);
      const own = (w) => ["direct", "child"].includes(q.relation.get(w.WorkloadId));
      q.ownRunning = q.running.filter(own);
      q.borrowingJobs = q.ownRunning.filter((w) => w.oversold);
      q.lentJobs = q.running.filter((w) => q.relation.get(w.WorkloadId) === "borrowed");
      q.ancestorJobs = q.running.filter((w) => q.relation.get(w.WorkloadId) === "ancestor");
      q.scheduledGpu = q.ownRunning.reduce((a, w) => a + gpuOf(w), 0);
      q.borrowingGpu = q.borrowingJobs.reduce((a, w) => a + gpuOf(w), 0);
      q.lowDims = q.running.reduce((a, w) => a + w.low, 0);
      q.dsw = q.running.filter((w) => w.WorkloadType === "dsw").length;
      q.dlc = q.running.length - q.dsw;
      const um = new Map();
      q.workloads.forEach((w) => {
        const e = um.get(w.UserId) || { id: w.UserId, name: w.UserName || "—", jobs: 0, queued: 0, gpus: 0, oversold: 0, low: 0, rels: new Set(), values: [] };
        e.jobs += 1;
        e.rels.add(q.relation.get(w.WorkloadId));
        if (w.queued) e.queued += 1;
        else {
          e.gpus += gpuOf(w);
          if (w.oversold) e.oversold += gpuOf(w);
          e.low += w.low;
          e.values.push(...w.gpus.map((g) => g.compute).filter((x) => x && x.fresh).map((x) => x.value));
        }
        um.set(w.UserId, e);
      });
      q.users = [...um.values()].map((e) => ({ ...e, compute: mean(e.values) })).sort((a, b) => b.gpus - a.gpus || b.jobs - a.jobs || a.name.localeCompare(b.name));
      q.unhealthyNodes = q.boundNodes.filter((n) => n.unhealthy);
    });
    d.quotaTree = (d.quotas || []).slice().sort((a, b) => (b.isRoot - a.isRoot) || a.depth - b.depth);
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
      // 借用和普通任务都可能有可信物理映射；缺口分别披露，不能把未映射当作空闲。
      unmapped: d.workloads.filter((w) => w.metrics.length && !w.cards.length && !w.oversold),
      borrowedUnmapped: running.filter((w) => w.oversold && gpuOf(w) > w.cards.length),
      borrowedMapped: cards.filter((c) => c.assignments.some((a) => a.borrowed === true && a.fresh)).length,
      conflicts: d.users.filter((u) => u.conflict),
      quotaMismatch: (d.quotas || []).filter((q) => q.mismatch),
      unhealthy: d.nodes.filter((n) => n.unhealthy),
      healBlocked: d.nodes.filter((n) => n.healTasks.length),
    };
    d.updatedAt = d.round?.finished_at || null;
    return d;
  }

  // ── 单卡 ───────────────────────────────────────────────
  // 实测数字 = 计算利用率；空闲卡以 0 表示原配额未占用，不写入计算指标；未知卡斜纹。
  function cardTip(c, opts) {
    const lines = [(opts.label || "GPU " + c.index)];
    if (c.state === "free") lines.push(c.possiblyBorrowed
      ? t("可能被借用：原配额空闲，0 表示原配额未占用，不代表实测 GPU 利用率为 0%。原配额申请资源时优先，借用任务会被回收、释放资源并重新排队。",
        "Possibly borrowed: idle for the original quota. 0 means no original-quota allocation, not measured 0% GPU utilization. The original quota has priority; borrowing is reclaimed and the borrower requeues.")
      : t("原配额空闲：未关联到任务，节点请求量与 Pod 映射一致。", "Idle for the original quota: no mapped workload, and node requests match Pod mapping."));
    if (c.state === "unknown") lines.push(c.possiblyBorrowed
      ? t("借用待确认：原配额未见占用，但尚未定位全部借用任务，不能确认此卡空闲。", "Borrowing unconfirmed: no original-quota allocation, but not all borrowers are mapped; this GPU cannot be confirmed idle.")
      : t("分配状态未知：Pod 映射缺失或与节点请求量不一致", "Allocation unknown: Pod mapping missing or inconsistent"));
    if (c.compute || c.state === "measured" || c.state === "assigned") {
      lines.push(t("计算 ", "Compute ") + pct1(c.compute?.value) + (c.compute && !c.compute.fresh ? t("（陈旧）", " (stale)") : ""));
      lines.push(t("显存 ", "Memory ") + pct1(c.memory?.value) + (c.memory && !c.memory.fresh ? t("（陈旧）", " (stale)") : ""));
      if (c.compute) lines.push(t("源采样 ", "Sampled ") + clock(c.compute.sampled_at));
    }
    (c.assignments || []).forEach((a) => lines.push((a.borrowed === true ? t("闲时借用 · ", "Idle borrowing · ") : "")
      + (a.owner_name || "—") + " · " + (a.workload_id || "—") + (a.pod ? " · " + a.pod : "") + (a.fresh ? "" : t("（上次关联）", " (last seen)"))));
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
    const text = c.state === "measured" ? String(Math.round(v)) : c.state === "free" ? "0" : c.state === "unknown" ? "?" : "—";
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
    const sub = c.state === "free" ? t("原配额空闲", "Quota idle") : c.state === "unknown" ? (c.possiblyBorrowed ? t("借用待确认", "Unconfirmed") : t("未知", "Unknown"))
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
      el("span", {}, [el("i", { class: "free" }), t("原配额空闲", "Quota idle")]),
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
    const borrowed = n.cards.filter((c) => c.borrowed).length;
    return [n.NodeStatus !== "Ready" ? chip(n.NodeStatus) : null,
      borrowed ? oversoldChip(t(`借用 ${borrowed} 卡`, `${borrowed} borrowed`)) : null,
      n.unhealthy ? el("span", { class: "pai-chip bad", title: tip }, [n.ReasonCode ? stateText(n.ReasonCode) : t("健康度 ", "Health ") + Math.round(n.healthPct) + "%"]) : null];
  }

  function allocationBar(m) {
    const s = m.sx;
    const assigned = m.cardsFlat.filter((c) => c.assignments.length).length;
    const seg = (n, cls, label) => (n ? el("span", { class: "seg " + cls, style: `flex:${n}`, title: `${label} ${n}` }) : null);
    return el("div", { class: "pai-alloc" }, [
      el("div", { class: "pai-alloc-bar" }, [
        seg(assigned, "used", t("已定位占用", "Mapped allocation")), seg(s.unknown, "unknown", t("未知", "Unknown")), seg(s.free, "free", t("原配额空闲", "Quota idle")),
      ]),
      el("div", { class: "pai-alloc-legend" }, [
        el("span", {}, [el("i", { class: "used" }), t(`已定位占用 ${assigned}`, `Mapped allocation ${assigned}`)]),
        s.unknown ? el("span", {}, [el("i", { class: "unknown" }), t(`未知 ${s.unknown}`, `Unknown ${s.unknown}`)]) : null,
        el("span", {}, [el("i", { class: "free" }), t(`原配额空闲 ${s.free}`, `Quota idle ${s.free}`)]),
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
        alertBox(s.free, t("原配额空闲卡", "Quota-idle GPUs"), s.free ? "good" : "",
          t("原配额未占用的卡可能被借用；原配额申请时优先，借用任务会被回收。能否调度仍取决于 CPU、内存、节点健康和配额策略。",
            "GPUs idle for their original quota may be borrowed. The original quota has priority and borrowing is reclaimed on demand. Scheduling still depends on CPU, memory, node health and quota policy.")),
        alertBox(s.lowDims, t(`已分配但近 10 分钟计算 <${LOW}%`, `Allocated, 10-min compute <${LOW}%`), s.lowDims ? "hot" : "",
          t(`按任务的卡统计，含已映射和未映射的借用任务；用近 10 分钟均值判断，至少 5 个分钟点。点击查看任务，按低负载卡数排序。`,
            `Counted per workload GPU, including mapped and unmapped borrowers, using the 10-minute mean with at least 5 points. Click to open workloads sorted by low-utilization GPUs.`),
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
  // 非总览页的紧凑状态行：五段等权读数，标签在上、数值在下；借用只作为已分配的后缀。
  function slimHeader(m) {
    const s = m.sx, sum = m.summary || {};
    const item = (label, value, tone, extra) => el("div", { class: "pai-slim-item" + (tone ? " " + tone : "") }, [
      el("span", { class: "pai-slim-label" }, [label]), el("span", { class: tone === "pai-slim-allocation" ? "pai-slim-amount" : "pai-slim-value" }, [el("b", {}, [value]), extra || null])]);
    return el("section", { class: "pai-slim" }, [
      el("div", { class: "pai-slim-title" }, [el("span", { class: "eyebrow" }, ["PAI · " + (m.region || "—")]), chip(m.state),
        el("span", { class: "pai-muted" }, [t("更新于 ", "Updated ") + ago(m.updatedAt)])]),
      el("div", { class: "pai-slim-items" }, [
        item(t("原配额空闲", "Quota idle"), String(s.free), s.free ? "good" : ""),
        item(t("已分配 GPU", "Allocated GPUs"), allocatedCount(m), "pai-slim-allocation", s.oversoldGpu
          ? el("small", { class: "pai-slim-borrowed", title: OVERSOLD_TIP() }, [el("i", { class: "pai-borrowed-swatch", "aria-hidden": "true" }), t(`借 ${gpus(s.oversoldGpu)}`, `${gpus(s.oversoldGpu)} borrowed`)]) : null),
        item(t("计算均值（任务）", "Task compute mean"), pct(sum.task_compute_mean)),
        el("div", { class: "pai-slim-item" }, [estimateMetric(m, "slim")]),
        item(t("运行任务", "Running"), String(s.running)),
      ]),
    ]);
  }

  const taskMeanHint = (sum) => t(`运行任务中 ${sum.task_measured_gpus || 0} 张 GPU 的新鲜指标，每卡等权；含闲时任务，缺测不计零`,
    `Fresh metrics from ${sum.task_measured_gpus || 0} GPUs in running tasks, weighted equally per GPU; includes idle-time tasks, excludes missing values`);
  const clusterMeanHint = (sum) => t(`监控工作空间的任务 GPU 计算之和 ÷ 自有池 ${gpus(sum.physical_gpus)} 张物理卡；含池内借用，不增加容量。仅任务/指标完整且数量不超容量时折算；不是可逐卡核实的全池实测值。`,
    `Monitored workspace workload compute / ${gpus(sum.physical_gpus)} owned physical GPUs, including borrowing without adding capacity. Estimated only with complete workload metrics and consistent counts; not a fully mapped physical measurement.`);

  function estimateMetric(m, variant = "kpi") {
    const sum = m.summary || {}, info = m.estimateInfo || {}, available = num(sum.pool_compute_estimate) != null;
    const reasons = available ? [] : (info.reasons?.length ? info.reasons : [{labelZh:"当前快照未满足估算条件",labelEn:"The snapshot does not meet estimation requirements"}]);
    const label = t("集群 GPU 利用率（估算）", "Pool GPU utilization (est.)");
    const reasonLabel = r => t(r.labelZh, r.labelEn);
    const taskState = status => ({Saving:t("保存中","saving"),Stopping:t("停止中","stopping"),Stopped:t("已停止","stopped"),
      Terminating:t("终止中","terminating"),Terminated:t("已终止","terminated"),Succeeded:t("已完成","completed"),Failed:t("已失败","failed"),
      Starting:t("启动中","starting"),Creating:t("创建中","creating"),EnvPreparing:t("环境准备中","preparing environment")}[status] || stateText(status));
    const shortReasons = reasons.flatMap(r => {
      if(r.code === "non_running_allocations" && r.tasks?.length && r.tasks.reduce((n,w)=>n+(num(w.gpus)||0),0) === r.gpus) {
        const byState = new Map();
        r.tasks.forEach(w=>{const state=w.scheduled === false ? t("未调度","unscheduled") : taskState(w.status);byState.set(state,(byState.get(state)||0)+(num(w.gpus)||0));});
        return [...byState].map(([state,count])=>({code:r.code,text:t(`${gpus(count)} 张卡${state}`,`${gpus(count)} GPUs ${state}`)}));
      }
      const count = gpus(r.gpus), compact = {
        non_running_allocations:t(`${count} 张卡占用状态待确认`,`${count} GPUs with unconfirmed allocation state`),
        missing_compute:t(`${count} 张卡缺指标`,`${count} GPUs missing metrics`),
        extra_compute:t(`多出 ${count} 条 GPU 指标`,`${count} extra GPU metrics`),
        retained_allocations:t(`${count} 张卡状态待确认`,`${count} GPUs awaiting confirmation`),
        unlisted_allocations:t(`${count} 张卡的任务未列出`,`${count} GPUs with unlisted workloads`),
        source_unavailable:t(`${r.sources?.length || "—"} 项关键来源未就绪`,`${r.sources?.length || "—"} required sources unavailable`),
        capacity_unknown:t("物理容量待确认","Physical capacity unconfirmed"),
        unknown_gpu_count:t(`${r.tasks?.length || "—"} 个任务卡数未知`,`${r.tasks?.length || "—"} workloads with unknown GPU counts`),
        over_capacity:t(`${count} 张卡超出物理容量`,`${count} GPUs over capacity`),
        mapping_conflict:t(`${r.nodes?.length || "—"} 个节点映射冲突`,`${r.nodes?.length || "—"} nodes with mapping conflicts`),
        shared_cards:t(`${count} 张卡映射重叠`,`${count} GPUs with overlapping mappings`),
      };
      return [{code:r.code,text:compact[r.code] || reasonLabel(r)}];
    }).sort((a,b)=> {
      const priority = code => ({non_running_allocations:0,missing_compute:1,retained_allocations:2}[code] ?? 3);
      return priority(a.code)-priority(b.code);
    });
    const id = "paiEstimateTip-" + variant;
    let button, tip;
    const current = () => ({button:UI.live(button), tip:UI.live(tip)});
    const close = () => {
      const live = current();live.tip._pinned = false;
      if(live.tip.matches(":popover-open")) live.tip.hidePopover();
      live.button.setAttribute("aria-expanded", "false");
    };
    const show = () => {
      const live = current();
      if(!live.button.isConnected || window.LiveDOM?.draft(live.button)) return;
      if(!live.tip.matches(":popover-open")) live.tip.showPopover();
      live.button.setAttribute("aria-expanded", "true");
      const b = live.button.getBoundingClientRect(), below = innerHeight-b.bottom-20, above = b.top-20;
      live.tip.style.maxHeight = Math.max(60, Math.max(below,above)) + "px";
      const box = live.tip.getBoundingClientRect(), useBelow = box.height<=below || below>=above;
      live.tip.style.left = Math.max(12, Math.min(b.right - box.width, innerWidth - box.width - 12)) + "px";
      live.tip.style.top = Math.max(12, useBelow ? b.bottom+8 : b.top-box.height-8) + "px";
    };
    const leave = () => setTimeout(() => {
      const live = current();
      if(!live.tip._pinned && !live.button.matches(":hover, :focus") && !live.tip.matches(":hover")) close();
    }, 100);
    const escape = e => { if(e.key === "Escape") { e.preventDefault();e.stopPropagation();close(); } };
    button = el("button", { type:"button", class:"pai-estimate-info", "aria-label":t("查看估算口径与当前原因", "Estimation method and current reasons"),
      "aria-expanded":"false", "aria-controls":id, "aria-describedby":id,
      onmouseenter:show, onmouseleave:leave, onfocus:show, onblur:leave, onkeydown:escape,
      onclick:e=>{e.preventDefault();e.stopPropagation();const live=current();if(live.tip._pinned)close();else{show();live.tip._pinned=true;}} },
      [el("span", {class:"pai-info-icon", "aria-hidden":"true"}, ["i"])]);
    tip = el("div", {id, class:"pai-estimate-tip", popover:"auto", role:"tooltip", onmouseleave:leave, onkeydown:escape,
      ontoggle:e=>{const live=current();if(e.newState === "closed"){live.tip._pinned=false;live.button.setAttribute("aria-expanded","false");}} }, [
      el("strong", {}, [label]),
      reasons.length ? el("ul", {class:"pai-estimate-detail-reasons"}, reasons.map(r=>el("li", {}, [reasonLabel(r),
        r.tasks?.length ? el("small", {}, [r.tasks.map(w=>(w.name || w.id) + (w.gpus != null ? t(`（${gpus(w.gpus)} 卡）`, ` (${gpus(w.gpus)} GPUs)`) : "")
          + (w.status ? " · " + taskState(w.status) : "")).join(" · ")]) : null]))) : null,
      el("p", {}, [clusterMeanHint(sum)]),
    ]);
    const previousTip = document.getElementById(id);
    if(previousTip?.matches(":popover-open")) {
      // The reconciler retains the open element; carry its geometry into the draft, then fit updated content.
      tip.style.cssText = previousTip.style.cssText;
      requestAnimationFrame(()=>{if(UI.live(tip)===previousTip && previousTip.matches(":popover-open"))show();});
    }
    const shown = shortReasons.slice(0, 2), rest = shortReasons.slice(2);
    return el("div", {class:"pai-estimate pai-estimate-" + variant + (available ? "" : " unavailable")}, [
      el("div", {class:"pai-estimate-value v"}, [available ? pct(sum.pool_compute_estimate) : t("暂无法估算", "Unavailable")]),
      el("div", {class:"pai-estimate-heading k"}, [el("span", {}, [label]), button]),
      available ? el("div", {class:"pai-estimate-summary hint"}, [t(`按 ${gpus(sum.physical_gpus)} 张物理卡折算`, `Across ${gpus(sum.physical_gpus)} physical GPUs`)])
        : el("div", {class:"pai-estimate-reasons hint"}, [...shown.map(r=>el("span", {}, [r.text])),
          rest.length ? el("span", {class:"pai-estimate-more", title: rest.map(r=>r.text).join("\n")}, ["+" + rest.length]) : null]),
      tip,
    ]);
  }

  const allocatedCount = (m) => m.summary?.pool_scheduled_gpus == null ? "—"
    : `${gpus(m.summary.pool_scheduled_gpus)} / ${gpus(m.summary.physical_gpus)}`;
  // 借用是已分配量的子集：紫色只用于斜纹色块，文字保持中性色；完整口径在悬停提示里。
  const borrowedLabel = (m) => {
    const n = m.summary?.pool_scheduled_gpus == null ? "—" : gpus(m.sx.oversoldGpu);
    return el("span", { class: "pai-borrowed-subset", title: OVERSOLD_TIP() }, [el("i", { class: "pai-borrowed-swatch", "aria-hidden": "true" }),
      t(`其中借用 ${n} 卡 · 不增加容量`, `Including ${n} borrowed GPUs · no extra capacity`)]);
  };

  function kpis(m) {
    const s = m.sx, sum = m.summary || {};
    const scheduled = num(sum.pool_scheduled_gpus), physical = num(sum.physical_gpus);
    const part = (v) => (physical ? Math.max(0, Math.min(100, v / physical * 100)) : 0);
    const meter = scheduled == null ? null : el("div", { class: "pai-kpi-meter", "aria-hidden": "true" }, [
      el("i", { style: `width:${part(scheduled - s.oversoldGpu)}%` }), el("i", { class: "idle", style: `width:${part(s.oversoldGpu)}%` })]);
    const items = [
      [String(s.physical), t("物理 GPU", "Physical GPUs"), plural(m.nodes.length, "节点", "node") + (s.types.length ? " · " + s.types.join(" / ") : "")],
      [allocatedCount(m), t("已分配 GPU", "Allocated GPUs"), t("运行任务的调度卡数 / 物理卡；借用只计一次", "Scheduled GPUs of running workloads / physical GPUs; borrowing counted once"), "allocation"],
      [pct(sum.task_compute_mean), t("计算均值（任务）", "Compute mean (tasks)"), taskMeanHint(sum)],
      [null, null, null, "estimate"],
      [String(s.running), t("运行中任务", "Running workloads"), `DSW ${s.dsw} · DLC ${s.dlc}`],
    ];
    // 来源陈旧时数值为最近成功值：整排压低明度并提示，不只靠页面级警告。
    const stale = m.state !== "ok";
    return el("div", { class: "kpis pai-kpis" + (stale ? " stale" : ""), title: stale ? t(`部分来源陈旧或采集失败：数值为最近成功值，更新于 ${ago(m.updatedAt)}`, `Some sources are stale or failed: values are the last successful ones, updated ${ago(m.updatedAt)}`) : null }, items.map(([v, k, hint, kind]) => kind === "estimate" ? el("div", {class:"kpi pai-estimate-kpi"}, [estimateMetric(m)]) : el("div", { class: "kpi" + (kind === "allocation" ? " pai-allocation-kpi" : ""), title: kind === "allocation" ? hint : null }, [
      el("div", { class: "v" }, [v]), el("div", { class: "k" }, [k]),
      kind === "allocation" ? meter : null,
      kind === "allocation" ? borrowedLabel(m) : el("div", { class: "hint", title: hint }, [hint]),
    ])));
  }

  function tabs(m, active) {
    const items = [["overview", t("总览", "Overview"), null], ["quotas", t("配额", "Quotas"), (m.quotas || []).length], ["nodes", t("节点", "Nodes"), m.nodes.length],
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
    const who = n.owners.length ? n.owners.join(" · ") : n.free === n.cards.length
      ? (n.possibly_borrowed ? t("可能被借用", "Possibly borrowed") : t("原配额空闲", "Quota idle")) : "—";
    return el("a", { "data-refresh-key": n.NodeName, class: "pai-node-tile" + (n.NodeStatus !== "Ready" || n.unhealthy ? " cordoned" : ""), href: href("node", n.NodeName),
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
      m.cardsFlat.some((c) => c.possiblyBorrowed && c.state === "unknown") ? el("div", { class: "pai-note warn" }, [t(
        "借用待确认：部分借用任务尚未定位，显示 ? 的卡不能判为空闲。",
        "Borrowing unconfirmed: some borrowers are still unmapped, so GPUs shown as ? cannot be treated as idle.")]) : null,
      s.oversoldGpu ? el("div", { class: "pai-note oversold" }, [t(
        `${s.oversoldJobs} 个运行任务借用共 ${gpus(s.oversoldGpu)} 卡，已确认物理映射 ${s.borrowedMapped} 卡。`,
        `${s.oversoldJobs} running workloads borrow ${gpus(s.oversoldGpu)} GPUs; ${s.borrowedMapped} have confirmed physical mappings. `), doc("idle")]) : null,
      methodDetails([
        t("每格一张物理卡，数字为最新计算利用率，底条为显存占比。只有节点、任务和两种 Pod 视图新鲜一致、且没有未定位的运行任务时，确认未分配的卡才显示 0。",
          "One square per physical GPU showing the latest compute; the bottom bar is memory. A confirmed unallocated GPU shows 0 only when nodes, workloads and both Pod views are fresh and consistent, with no unlocated running workload."),
        t("借用卡显示借用任务与使用人；指标卡号与物理卡号不能可靠关联时利用率保持未知，不按空闲补零。借用不增加物理容量，原配额需要时会回收。",
          "Borrowed GPUs show the borrowing workload and owner; utilization stays unknown when metric indices cannot be matched to physical indices and is never filled in as idle. Borrowing adds no capacity and is reclaimed by the original quota."),
        t("已定位借用的 GPU 卡号见节点与任务详情；未确认的映射保持未知，显示为 ?。", "GPU indices of located borrowers are on node and workload pages; unconfirmed mappings stay unknown and show ?."),
      ]),
    ], { tools: legend(), id: "paiHeat" });
  }

  function nodeRow(n, m) {
    const byId = Object.fromEntries(m.workloads.map((w) => [w.WorkloadId, w]));
    const jobs = n.workloadIds.map((id) => byId[id]).filter(Boolean);
    return el("div", { class: "pai-node-row", "data-refresh-key": n.NodeName }, [
      el("a", { class: "pai-node-id", href: href("node", n.NodeName), title: n.NodeName }, [
        el("b", {}, [n.short]),
        el("small", {}, [`${n.GPUType || "GPU"} · ${gpus(n.GPU)} GPU` + (n.quotaNames.length ? " · " + n.quotaNames.join(", ") : "")]),
        el("span", { class: "pai-inline" }, nodeChips(n)),
      ]),
      el("div", { class: "pai-node-jobs" }, jobs.length ? jobs.map((w) => el("div", {}, [
        link(w.WorkloadName, href("workload", w.WorkloadId)), el("small", {}, [" · " + (w.UserName || "—")]),
        w.oversold ? oversoldChip() : null,
      ])) : [el("span", { class: "pai-muted" }, [n.free ? t(`原配额空闲 ${n.free} 卡`, `${n.free} quota-idle GPUs`) : t("无关联任务", "No mapped workload")])]),
      el("div", { class: "cards" }, n.cards.map((c) => card(c, {
        href: c.assignments[0] ? href("workload", c.assignments[0].workload_id) : null }))),
    ]);
  }

  function nodesPanel(m) {
    const filters = [["all", t("全部", "All"), m.nodes.length], ["busy", t("有任务", "In use"), m.nodes.filter((n) => n.assigned).length],
      ["free", t("有原配额空闲卡", "Has quota-idle GPUs"), m.nodes.filter((n) => n.free).length]];
    const list = el("div", { class: "pai-node-list" });
    const draw = () => {
      const rows = m.nodes.filter((n) => ui.nodes === "all" || (ui.nodes === "busy" ? n.assigned : n.free))
        .sort((a, b) => b.assigned - a.assigned || a.NodeName.localeCompare(b.NodeName));
      UI.live(list).replaceChildren(...(rows.length ? rows.map((n) => nodeRow(n, m)) : [note(t("没有符合条件的节点", "No matching nodes"))]));
      UI.live(seg).querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === ui.nodes));
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
    if (w.oversold) return oversoldChip(t("闲时 · 映射待确认", "Idle-time · unmapped"));
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

  // 排队列表默认折叠，摘要始终保留总数与配置风险；展开后可查看全部任务。
  function queueBanner(m) {
    const list = m.sx.queued;
    if (!list.length) return null;
    const bad = m.sx.unschedulable.length, hard = m.sx.blocked.length;
    const preview = list.slice(0, 2).map((w) => w.WorkloadName || w.WorkloadId).join(" · ");
    const longest = list.reduce((a, w) => (w.queuedFor != null && (a == null || w.queuedFor > a) ? w.queuedFor : a), null);
    const details = el("details", { id: "paiQueue", class: "pai-queue" + (bad ? " bad" : "") }, [
      el("summary", { class: "pai-queue-head", title: t("展开或收起排队列表", "Show or hide the queue") }, [
        el("div", { class: "pai-queue-summary" }, [
          el("div", { class: "pai-queue-line" }, [el("strong", {}, [t(`排队中的任务 ${list.length} 个`, `${list.length} queued workloads`)]),
            hard ? el("span", { class: "pai-chip bad" }, [t(`${hard} 个当前配置放不下`, `${hard} cannot fit now`)]) : null,
            bad - hard ? el("span", { class: "pai-chip warn" }, [t(`${bad - hard} 个可能排不上`, `${bad - hard} may never fit`)]) : null,
            longest != null ? el("span", { class: "pai-muted" }, [t(`最长已等 ${dur(longest)}`, `longest wait ${dur(longest)}`)]) : null]),
          el("small", { class: "pai-queue-preview", title: preview }, [
            el("span", { class: "pai-queue-preview-names" }, [preview]),
            list.length > 2 ? el("span", { class: "pai-queue-preview-more" }, [t(`· 另 ${list.length - 2} 个`, `· ${list.length - 2} more`)]) : null])]),
        el("span", { class: "pai-queue-toggle", "aria-hidden": "true" }, [el("span", { class: "chevron" }, ["▾"])]),
      ]),
      el("div", { class: "pai-queue-docs pai-tools" }, [doc("schedule"), doc("idle", t("闲时资源", "Idle-time"))]),
      el("div", { class: "pai-queue-list", tabindex: "0", role: "region", "aria-label": t("排队任务列表，可滚动", "Scrollable queued workload list"),
        "aria-describedby": list.length > 3 ? "paiQueueScrollHint" : null }, list.map((w) => el("div", { "data-refresh-key": w.WorkloadId, class: "pai-queue-item" + (w.unschedulable ? " bad" : w.longWait ? " long" : "") }, [
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
      list.length > 3 ? el("small", { id: "paiQueueScrollHint", class: "pai-queue-scroll-hint" }, [t(`↕ 列表可滚动，查看全部 ${list.length} 项`, `↕ Scroll the list to see all ${list.length} workloads`)]) : null,
    ]);
    if (ui.queueOpen) details.open = true;
    const remember = e => { if (!window.LiveDOM?.draft(e.currentTarget)) ui.queueOpen = e.currentTarget.open; };
    details._uiEvents = { toggle: remember };
    details.addEventListener("toggle", remember);
    return details;
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
      ["memory", t("显存均值", "Memory"), "c-sec"], [null, t("单卡计算", "Per GPU"), "c-sec"], ["cpu", t("CPU · 内存", "CPU · RAM"), "c-sec"], [null, t("节点", "Node")], [null, t("状态", "State")]]
      .filter(([k]) => !(opts.hideOwner && k === "owner"));
    const label = (k) => (cols.find((c) => c[0] === k) || [])[1];
    const head = el("tr", {}, cols.map(([k, label, cls]) => el("th", {
      class: (cls || "") + (k && sortable ? " sortable" : "") + (k && ui.sort === k && sortable ? " sorted" : ""),
      onclick: k && sortable ? () => { ui.desc = ui.sort === k ? !ui.desc : !["name", "owner"].includes(k); ui.sort = k; opts.redraw && opts.redraw(); } : null,
    }, [label, k && sortable && ui.sort === k ? (ui.desc ? " ↓" : " ↑") : ""])));
    const body = rows.map((w) => {
      const scheduled = num(w.scheduled_gpu), requested = num(w.requested_gpu);
      const tip = w.measured ? t(`最新计算值 ${w.measured} 卡；近 10 分钟均值 <${LOW}% 的 ${w.low} 卡`, `${w.measured} GPUs with recent compute; ${w.low} with 10-min mean under ${LOW}%`) : "";
      return el("tr", { "data-refresh-key": w.WorkloadId, class: w.unschedulable ? "pai-row-bad" : w.queued ? "pai-row-queued" : null }, [
        el("td", { "data-label": label("name") }, [el("div", { class: "pai-wl" }, [
          link(w.WorkloadName, href("workload", w.WorkloadId), "pai-wl-name"),
          el("div", { class: "pai-wl-sub" }, [typeChip(w.WorkloadType), w.QuotaId ? link(w.quota, href("quota", w.QuotaId), "pai-wl-quota") : el("span", {}, [w.quota]),
            w.oversold ? oversoldChip() : null, opts.relation ? relChip(opts.relation.get(w.WorkloadId)) : null]),
        ])]),
        opts.hideOwner ? null : el("td", { "data-label": "Owner" }, [link(w.UserName, href("user", w.UserId))]),
        el("td", { class: "num", "data-label": "GPU", title: t("任务申请卡数（逻辑量）", "Requested GPUs (logical)") }, [gpus(requested),
          scheduled != null && scheduled !== requested ? el("small", { class: "pai-muted" }, [t(` · 调度 ${gpus(scheduled)}`, ` · sched ${gpus(scheduled)}`)]) : null]),
        el("td", { "data-label": label("compute") }, [el("span", { class: "pai-inline" }, [bar(w.compute, { title: tip, stale: w.stale }),
          w.low ? el("small", { class: "pai-low" }, [t(`${w.low} 卡<${LOW}%`, `${w.low} <${LOW}%`)]) : null])]),
        el("td", { "data-label": label("memory"), class: "c-sec" }, [bar(w.memory, { memory: true, stale: w.stale })]),
        el("td", { "data-label": t("单卡计算", "Per GPU"), class: "c-sec" }, [strip(w)]),
        el("td", { "data-label": t("CPU · 内存", "CPU · RAM"), class: "c-sec" }, [hostCell(w)]),
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
      UI.live(host).replaceChildren(...[sortNote, workloadsTable(list, { redraw: draw }),
        opts.limit && total > list.length ? el("a", { class: "pai-more", href: href("workloads") }, [t(`查看全部 ${total} 个任务 →`, `All ${total} workloads →`)]) : null].filter(Boolean));
      UI.live(seg).querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === ui.type));
    }
    draw();
    const unmapped = m.sx.unmapped.length, borrowedUnmapped = m.sx.borrowedUnmapped.length;
    return panel(opts.title || t("运行任务", "Workloads"), [
      borrowedUnmapped ? el("div", { class: "pai-note oversold" }, [t(
        `${borrowedUnmapped} 个闲时借用任务的物理映射尚未完整确认；已有映射显示在节点列，缺失部分保持未知。借用计入团队占用，不增加物理容量。GPU 列为任务申请量。`,
        `${borrowedUnmapped} borrowing workloads have incomplete physical mappings. Confirmed mappings appear in the node column; missing mappings stay unknown. Borrowing is included in team allocation without adding capacity. GPU is the requested amount. `), doc("idle")]) : null,
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
    return el("span", { class: "pai-inline" }, u.quotaUse.map((q) => el("a", { class: "pai-user-chip" + (q.oversold ? " oversold" : ""), href: href("quota", q.id),
      title: q.oversold ? OVERSOLD_TIP() : t("常规运行任务卡数（优先调度量，缺失时用申请量）", "Running GPUs (scheduled, requested as fallback)") },
      [q.name, el("b", {}, [gpus(q.gpus)]), q.oversold ? t(" 闲时", " idle-time") : null])));
  }

  function usersTable(users, compact, limit) {
    let rows = users.slice().sort((a, b) => (num(b.submitted_gpu) ?? 0) - (num(a.submitted_gpu) ?? 0) || (a.Username || "").localeCompare(b.Username || ""));
    if (limit) rows = rows.slice(0, limit);
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
    const body = rows.map((u) => el("tr", { "data-refresh-key": u.UserId }, cols.map(([label, cell, numeric]) => el("td", { "data-label": label, class: numeric ? "num" : "" }, [cell(u)]))));
    return el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table" + (compact ? " compact" : "") }, [
      el("thead", {}, [el("tr", {}, cols.map(([label, , numeric]) => el("th", { class: numeric ? "num" : "" }, [label])))]),
      el("tbody", {}, body.length ? body : [el("tr", {}, [el("td", { colspan: cols.length, class: "pai-empty" }, [t("当前无记录", "No records")])])]),
    ])]);
  }

  // 总览里的配额面板：每行一个配额，名称进入配额详情；人名 chip 超过上限折叠，状态标记只在异常时出现。
  function quotasPanel(m) {
    const list = m.quotaTree || (m.quotas || []);
    const anyBreakdown = list.some((q) => q.hasBreakdown);
    const MAX_CHIPS = 6;
    const userChip = (u, cls, title, suffix) => el("a", { class: "pai-user-chip" + (cls ? " " + cls : ""), href: href("user", u.id), title },
      [u.name, el("b", {}, [gpus(u.gpus)]), suffix || null]);
    const fold = (chips, rest) => (rest.length ? [...chips, el("span", { class: "pai-user-chip more", title: rest.map((u) => `${u.name} ${gpus(u.gpus)}`).join("\n") }, ["+" + rest.length])] : chips);
    return panel(t("配额", "Quotas"), [
      el("div", { class: "pai-quotas" }, list.map((q) => {
        const cap = num(q.gpu_capacity), used = num(q.gpu_used), shown = quotaShown(q), root = q.isRoot;
        const who = fold(q.direct.slice(0, MAX_CHIPS).map((u) => userChip(u, "", t(`${u.jobs} 个配额内任务直接提交到 ${q.quota_name}，共申请 ${gpus(u.gpus)} 卡`, `${u.jobs} in-quota workloads, ${gpus(u.gpus)} GPUs requested`))), q.direct.slice(MAX_CHIPS));
        if (num(q.childUsed) > 0) who.push(el("span", { class: "pai-user-chip child", title: t("子配额的用量合计，已包含在本配额中", "Subquota usage, included in this quota") },
          [t("子配额", "Subquotas"), el("b", {}, [gpus(q.childUsed)])]));
        if (q.borrowedBy.length) {
          const lent = q.borrowedBy.slice(0, MAX_CHIPS).map((u) => userChip(u, "borrowed", t(`${u.quota} 配额的任务占用本配额节点上的 ${gpus(u.gpus)} 张卡`, `${u.quota} workloads use ${gpus(u.gpus)} GPUs on this quota's nodes`),
            u.quota !== q.parent?.quota_name ? " · " + u.quota : null));
          who.push(el("span", { class: "pai-quota-label" }, [t("父配额任务占用", "Parent-quota workloads")]), ...fold(lent, q.borrowedBy.slice(MAX_CHIPS)));
        }
        if (q.oversoldUsers.length) who.push(el("span", { class: "pai-quota-label" }, [t("借入（闲时）", "Borrowing in (idle-time)")]), ...q.oversoldUsers.map((u) => userChip(u, "oversold", OVERSOLD_TIP())));
        const flags = [];
        if (q.oversold_enabled === false) flags.push(el("span", { class: "pai-chip warn",
          title: t("控制台“闲时共享”已关闭：本级和子级的空闲资源不供闲时任务使用。它不决定本配额的任务能否借用别处资源，那由任务的提交策略决定。接口：OversoldUsageConfig.Disabled",
            "Console idle sharing is off: idle capacity here and below is not offered to idle-time workloads. It does not decide whether this quota's workloads may borrow elsewhere; the job's policy does. API: OversoldUsageConfig.Disabled") },
          [t("闲时共享关闭", "Idle sharing off")]));
        if (q.nodesTotal && q.nodesSchedulable < q.nodesTotal) flags.push(el("span", { class: "pai-chip " + (q.nodesSchedulable ? "warn" : "bad"),
          title: t("绑定节点中状态就绪且健康的数量；配置容量不等于健康可调度的卡", "Bound nodes that are ready and healthy; configured capacity is not schedulable capacity") },
          [t(`可调度节点 ${q.nodesSchedulable}/${q.nodesTotal}`, `Schedulable nodes ${q.nodesSchedulable}/${q.nodesTotal}`)]));
        if (q.mismatch) flags.push(el("span", { class: "pai-flag", title: q.hasBreakdown
          ? t("常规运行任务卡数（优先调度量，缺失时用申请量）与配额接口的“本配额分配”不一致；页面不推断原因，需在 PAI 控制台核实。", "Running GPUs (scheduled, requested as fallback) differ from the quota's own allocation; check the PAI console.")
          : t("常规运行任务卡数（含子配额用量）与配额用量不一致；页面不推断原因，需在 PAI 控制台核实。", "Running GPUs (plus subquota usage) differ from quota usage; check the PAI console.") },
          [t(`任务申请 ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "分配" : "用量"} ${gpus(q.reported)}`, `Requested ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "allocated" : "used"} ${gpus(q.reported)}`)]));
        return el("div", { "data-refresh-key": q.quota_id, class: "pai-quota" + (root ? " root" : "") }, [
          el("div", { class: "pai-quota-main" }, [
            el("span", { class: "pai-quota-name", title: q.quota_name }, [root ? null : el("span", { class: "pai-quota-branch", "aria-hidden": "true" }, ["└"]),
              link(q.quota_name || q.quota_id, href("quota", q.quota_id), "pai-quota-link"), root ? el("small", {}, [t(" 根", " root")]) : null]),
            quotaBar(q),
            el("span", { class: "pai-quota-num", title: q.hasBreakdown ? t(`已分配 ${gpus(shown)}（AllocatedQuota，含父配额任务占用）；旧 UsedQuota ${gpus(used)}（官方已标弃用）`, `Allocated ${gpus(shown)} (AllocatedQuota, incl. parent workloads); legacy UsedQuota ${gpus(used)} (deprecated)`) : "" },
              [`${gpus(shown)} / ${gpus(cap)}`]),
            q.status && q.status !== "Ready" ? chip(q.status) : null,
          ]),
          flags.length || who.length ? el("div", { class: "pai-quota-users" }, [...flags, root && q.direct.length ? el("span", { class: "pai-quota-label" }, [t("直接提交", "Direct")]) : null, ...who]) : null,
        ]);
      })),
      anyBreakdown ? quotaLegend() : null,
      methodDetails([
        t("数字为配额资源上的实际分配 / 容量，来自配额接口；父配额包含子配额，容量不可相加。", "Numbers are allocation / capacity from the quota API; parents include subquotas and capacities never add up."),
        t("人名按任务的 QuotaId 归入其直接提交的配额，卡数优先使用调度量，缺失时使用申请量；父配额任务落在子配额节点上时，列在该子配额的“父配额任务占用”下。",
          "Users are listed under the quota their workloads were submitted to, with scheduled GPUs (requested as fallback); parent-quota workloads placed on a subquota's nodes appear under that subquota as parent-quota workloads."),
        t("闲时借用是团队占用的子集，不增加容量。控制台“闲时共享”默认开启，只在关闭时标注；可调度节点少于绑定节点时标注数量。",
          "Idle borrowing is a subset of team allocation and adds no capacity. Console idle sharing is on by default and only flagged when off; schedulable nodes are flagged when fewer than bound nodes."),
      ]),
    ], { tools: link(t("全部配额 →", "All quotas →"), href("quotas"), "pai-more"), id: "paiQuotas" });
  }

  // ── 配额标签页：根配额 + 子配额卡片；详情页汇总该配额的节点、任务、用户与本周统计 ─────
  // 任务按两种口径同时归入配额：提交到该配额（含子配额），或实际跑在该配额绑定的节点上。
  const REL = {
    direct: ["直接提交", "Submitted here"], child: ["子配额提交", "Subquota"],
    ancestor: ["父配额任务", "Parent-quota job"], borrowed: ["借出给闲时任务", "Lent to idle-time job"],
  };
  const relChip = (rel) => (!rel || rel === "direct" ? null : el("span", { class: "pai-chip rel-" + rel }, [t(...REL[rel])]));
  const quotaShown = (q) => (q.hasBreakdown ? num(q.allocated_gpu) : num(q.gpu_used));

  function quotaSegments(q) {
    const segs = q.hasBreakdown
      ? [["", q.self_allocated_gpu, t("本配额任务", "This quota")], ["child", q.descendants_allocated_gpu, t("子配额", "Subquotas")],
        ["borrowed", q.ancestors_allocated_gpu, t("父配额任务占用", "Used by parent quota")]]
      : [["", q.gpu_used, t("配额用量", "Quota usage")]];
    return segs.filter(([, v]) => num(v)).map(([cls, v, label]) => ({ cls, v: num(v), label }));
  }
  function quotaBar(q) {
    const cap = num(q.gpu_capacity);
    const width = (v) => (cap ? Math.max(0, Math.min(100, v / cap * 100)) : 0);
    return el("span", { class: "pai-quota-bar" }, quotaSegments(q).map((s) => el("i", { class: s.cls || null, style: `width:${width(s.v)}%`, title: `${s.label} ${gpus(s.v)}` })));
  }

  // 每格一张物理卡，按绑定节点分组；颜色语义与热力图一致。
  function quotaStrip(q) {
    return el("div", { class: "pai-q-strip" }, q.boundNodes.map((n) => el("span", {
      class: "pai-q-strip-node" + (n.NodeStatus !== "Ready" || n.unhealthy ? " cordoned" : ""),
      title: n.NodeName + (n.quotaNames.length ? " · " + n.quotaNames.join(", ") : "") },
    n.cards.map((c) => el("i", { class: c.state + (c.low ? " low" : ""), style: cardParts(c).style })))));
  }

  function quotaFlags(q) {
    const flags = [];
    if (q.queued.length) flags.push(el("span", { class: "pai-chip " + (q.queued.some((w) => w.unschedulable) ? "bad" : "warn") }, [t(`排队 ${q.queued.length}`, `${q.queued.length} queued`)]));
    if (q.unhealthyNodes.length) flags.push(el("span", { class: "pai-chip bad" }, [t(`节点异常 ${q.unhealthyNodes.length}`, `${q.unhealthyNodes.length} unhealthy`)]));
    if (q.lowDims) flags.push(el("span", { class: "pai-chip held", title: t(`已分配但近 10 分钟计算 <${LOW}% 的卡`, `Allocated GPUs with 10-min compute under ${LOW}%`) }, [t(`${q.lowDims} 卡计算<${LOW}%`, `${q.lowDims} GPUs <${LOW}%`)]));
    // 方向固定为“借入 / 借出”：借入 = 本配额任务使用别处闲时资源；借出 = 闲时任务使用本配额节点。
    // 根配额的借入与借出是同一笔池内借用，只标一次。
    if (q.isRoot && q.borrowingGpu) flags.push(oversoldChip(t(`池内闲时借用 ${gpus(q.borrowingGpu)} 卡`, `${gpus(q.borrowingGpu)} GPUs borrowed within the pool`)));
    else {
      if (q.borrowingGpu) flags.push(oversoldChip(t(`借入 ${gpus(q.borrowingGpu)} 卡`, `Borrowing in ${gpus(q.borrowingGpu)}`)));
      if (q.cards.lent) flags.push(el("span", { class: "pai-chip lent", title: OVERSOLD_TIP() }, [t(`借出 ${q.cards.lent} 卡`, `Lending out ${q.cards.lent}`)]));
    }
    if (q.mismatch) flags.push(el("span", { class: "pai-flag", title: t("常规运行任务卡数与配额接口的分配不一致，需在 PAI 控制台核实", "Running GPUs differ from the quota's own allocation; check the PAI console") }, [t("申请≠分配", "Mismatch")]));
    return flags;
  }

  function quotaCard(q) {
    const cap = num(q.gpu_capacity), shown = quotaShown(q);
    const stat = (v, k, tone) => el("div", { class: "pai-q-stat" + (tone ? " " + tone : "") }, [el("b", {}, [v]), el("span", {}, [k])]);
    return el("a", { class: "pai-q-card" + (q.isRoot ? " root" : ""), href: href("quota", q.quota_id), "data-refresh-key": q.quota_id }, [
      el("div", { class: "pai-q-head" }, [
        el("div", { class: "pai-q-title" }, [
          el("div", { class: "pai-q-name" }, [el("b", { title: q.quota_name }, [q.quota_name || q.quota_id]),
            el("small", {}, [q.isRoot ? t("根配额 · 全池去重视图；子配额的任务与用户可能重叠，不可相加", "Root quota · deduplicated pool view; subquota workloads and users may overlap and never add up") : t("子配额", "Subquota")])]),
          el("div", { class: "pai-q-flags" }, [q.status && q.status !== "Ready" ? chip(q.status) : null, ...quotaFlags(q)]),
        ]),
        el("div", { class: "pai-q-cap", title: t("已分配 / 容量，来自配额接口；父配额包含子配额", "Allocated / capacity from the quota API; parents include subquotas") }, [
          el("b", {}, [gpus(shown)]), el("span", {}, [" / " + gpus(cap)]),
          el("small", {}, [cap && shown != null ? Math.round(shown / cap * 100) + "%" : ""])]),
      ]),
      quotaBar(q),
      el("div", { class: "pai-q-stats" }, [
        stat(`${q.nodesSchedulable} / ${q.nodesTotal}`, t("可调度节点", "Schedulable nodes"), q.nodesTotal && q.nodesSchedulable < q.nodesTotal ? "warn" : ""),
        stat(String(q.running.length), q.isRoot ? t("运行任务 · 去重", "Running · deduplicated") : t("运行任务", "Running"), ""),
        stat(String(q.users.length), q.isRoot ? t("用户 · 去重", "Users · deduplicated") : t("用户", "Users"), ""),
        stat(pct(q.nodeComputeMean), t("节点计算均值", "Node compute"), ""),
      ]),
      quotaStrip(q),
    ]);
  }

  function quotaLegend() {
    return el("div", { class: "pai-quota-legend" }, [
      el("span", {}, [el("i"), t("本配额任务", "This quota")]), el("span", {}, [el("i", { class: "child" }), t("子配额", "Subquotas")]),
      el("span", {}, [el("i", { class: "borrowed" }), t("父配额任务占用", "Parent-quota workloads")]),
      el("span", {}, [el("i", { class: "oversold" }), t("闲时借用（计入团队总占用）", "Borrowing (included in team total)")]),
    ]);
  }

  function quotasTab(m) {
    const roots = m.quotaTree.filter((q) => q.isRoot), rest = m.quotaTree.filter((q) => !q.isRoot);
    return panel(t("配额", "Quotas"), [
      ...roots.map(quotaCard),
      rest.length ? el("div", { class: "pai-q-grid" }, rest.map(quotaCard)) : null,
      quotaLegend(),
      methodDetails([
        t("已分配 / 容量来自配额接口；父配额包含子配额，容量不可相加。小格为绑定节点上的物理卡，颜色为实测计算利用率。", "Allocation / capacity come from the quota API; parents include subquotas and capacities never add up. Squares are physical GPUs on bound nodes, coloured by measured compute."),
        t("运行任务与用户同时按提交配额和实际落点归入：父配额任务跑在子配额节点上时也计入该子配额，每个任务只计一次。", "Running workloads and users count by submission quota and by placement: a parent-quota workload running on a subquota's nodes also counts there, each workload once."),
        t("闲时借用是任务占用的子集，不增加容量。方向固定为“借入 / 借出”：借入 = 本配额任务使用其他配额的闲时资源；借出 = 闲时任务使用本配额节点。根配额只标池内借用。", "Idle borrowing is a subset of task allocation and adds no capacity. Direction is always “borrowing in / lending out”: in = this quota's workloads using idle capacity elsewhere; out = idle-time workloads using this quota's nodes. The root quota only shows pool-internal borrowing."),
      ]),
    ], { tools: el("div", { class: "pai-tools" }, [doc("quota", t("配额", "Quotas")), doc("preempt", t("抢占", "Preemption")), doc("idle", t("闲时资源", "Idle-time"))]), id: "paiQuotaList" });
  }

  function quotaUsersTable(q) {
    const relText = (u) => [...u.rels].filter((r) => r === "ancestor" || r === "borrowed").map((r) => t(...REL[r])).join(" · ");
    const cols = [[t("用户", "User"), (u) => el("div", { class: "pai-user-cell" }, [link(u.name, href("user", u.id)), relText(u) ? el("small", {}, [relText(u)]) : null])],
      [t("任务", "Jobs"), (u) => el("span", {}, [String(u.jobs), u.queued ? el("small", { class: "pai-low" }, [t(` · 排队 ${u.queued}`, ` · ${u.queued} queued`)]) : null]), true],
      [t("占用 GPU", "GPUs"), (u) => gpus(u.gpus), true],
      [t("其中闲时", "Idle-time"), (u) => (u.oversold ? oversoldChip(gpus(u.oversold)) : el("span", { class: "pai-dash" }, ["—"])), true],
      [t("计算均值", "Compute"), (u) => bar(u.compute)],
      [t(`计算<${LOW}%`, `<${LOW}%`), (u) => (u.low ? el("span", { class: "pai-low" }, [String(u.low)]) : "0"), true]];
    return el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table compact" }, [
      el("thead", {}, [el("tr", {}, cols.map(([label, , numeric]) => el("th", { class: numeric ? "num" : "" }, [label])))]),
      el("tbody", {}, q.users.length ? q.users.map((u) => el("tr", { "data-refresh-key": u.id }, cols.map(([label, cell, numeric]) => el("td", { "data-label": label, class: numeric ? "num" : "" }, [cell(u)]))))
        : [el("tr", {}, [el("td", { colspan: cols.length, class: "pai-empty" }, [t("当前无任务", "No workloads")])])]),
    ])]);
  }

  function quotaWorkloadsPanel(q) {
    const count = (rel) => q.workloads.filter((w) => q.relation.get(w.WorkloadId) === rel).length;
    const filters = [["all", t("全部", "All"), q.workloads.length], ["direct", t("直接提交", "Submitted here"), count("direct")],
      ["child", t("子配额", "Subquotas"), count("child")], ["ancestor", t("父配额任务", "Parent-quota"), count("ancestor")],
      ["borrowed", t("借出", "Lent out"), count("borrowed")]].filter(([k, , n]) => k === "all" || n);
    if (!filters.some(([k]) => k === ui.quota)) ui.quota = "all";
    const host = el("div");
    const draw = () => {
      const list = q.workloads.filter((w) => ui.quota === "all" || q.relation.get(w.WorkloadId) === ui.quota);
      UI.live(host).replaceChildren(workloadsTable(list, { redraw: draw, relation: q.relation }));
      UI.live(seg).querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === ui.quota));
    };
    const seg = el("div", { class: "pai-seg" }, filters.map(([k, label, n]) => el("button", { "data-k": k, onclick: () => { ui.quota = k; draw(); } }, [label, el("span", { class: "count" }, [String(n)])])));
    draw();
    return panel(t("任务", "Workloads"), [host], { tools: filters.length > 2 ? seg : null });
  }

  // 配额详情页复用排行数据：同一时间窗 10 分钟内不重复请求，减轻小规格生产实例负担；排行页仍每次刷新。
  const rankCache = new Map();
  async function cachedRanking(window) {
    const hit = rankCache.get(window);
    if (hit && Date.now() - hit.at < 600000) return hit.data;
    const data = await API.paiRanking(window);
    rankCache.set(window, { at: Date.now(), data });
    return data;
  }

  // 本周配额统计：复用排行接口的 Feature 行；根配额用其单列行。失败时只提示，不影响其余区块。
  async function quotaWeekPanel(host, q) {
    const body = el("div", { class: "pai-q-week" }, [note(t("读取中…", "Loading…"))]);
    host.appendChild(panel(t("本周统计", "This week"), [body], { tools: link(t("查看排行 →", "Ranking →"), href("ranking"), "pai-more"), id: "paiQuotaWeek" }));
    let data;
    try { data = await cachedRanking("week"); } catch (e) {
      if (!host.isConnected) return;
      if (!GM.refreshFailed?.(host)) PageRecovery.show();
      UI.live(body).replaceChildren(note(t("排行读取失败", "Failed to load ranking")));
      return;
    }
    if (!host.isConnected) return;
    const row = q.isRoot ? data.root_quota : (data.features || []).find((f) => String(f.quota_id) === String(q.quota_id));
    const range = el("div", { class: "pai-rank-range" }, [el("span", { class: "mono" }, [`${minuteClock(data.since, data.timezone)} → ${minuteClock(data.until, data.timezone)}`]),
      el("span", {}, [reportZone(data) + t(" · 本周进行中", " · week in progress")])]);
    if (!row) { UI.live(body).replaceChildren(range, note(t("本周排行中没有该配额的记录。", "No record for this quota in this week's ranking."))); return; }
    const known = row.gpu_hours != null;
    const stat = (label, value, subs, extra) => el("div", { class: "pai-rank-stat" }, [el("span", {}, [label]), el("b", {}, [value]), extra || null, ...subs.filter(Boolean)]);
    const small = (text, tone) => el("small", { class: tone || null }, [text]);
    const meter = (v) => (v == null ? null : el("span", { class: "meter" }, [el("i", { style: `width:${Math.max(0, Math.min(100, v))}%` })]));
    const direct = row.direct_gpu_hours ?? row.gpu_hours, via = row.root_attributed_gpu_hours || 0;
    const coverage = row.gpu_hours ? share((row.measured_gpu_hours || 0) / row.gpu_hours * 100) : "—";
    UI.live(body).replaceChildren(range, el("div", { class: "pai-rank-stats pai-q-week-stats" }, [
      stat(t("占用 GPU·小时", "Occupied GPU-hours"), hrs(row.gpu_hours), [
        !known ? small(t("该窗口无任务历史", "No task history in this window"))
          : q.isRoot ? small(t(`仅直接提交；其中 ${hrs(via)} 已归入 Feature`, `Direct submissions only; ${hrs(via)} attributed to features`))
            : small(t(`直接提交 ${hrs(direct)} · 从根配额归入 ${hrs(via)}`, `${hrs(direct)} direct · ${hrs(via)} from the root quota`)),
        row.oversold_gpu_hours > 0 ? small(t(`其中借入 ${hrs(row.oversold_gpu_hours)}`, `${hrs(row.oversold_gpu_hours)} borrowed in`)) : null]),
      stat(t("配额记账占用率", "Quota-reported utilization"), share(row.occupancy_pct), [small(t(`时间覆盖 ${share(row.quota_coverage_pct)}`, `${share(row.quota_coverage_pct)} coverage`))], meter(row.occupancy_pct)),
      stat(t("占用期间计算效率", "Compute while occupied"), pct1(row.hardware_efficiency_pct), [small(t(`指标覆盖 ${coverage}`, `${coverage} measured`))], meter(row.hardware_efficiency_pct)),
      stat(t("任务数", "Jobs"), row.workloads == null ? "—" : String(row.workloads), [known ? small(t("本窗口内出现过的任务", "Workloads seen in this window")) : null]),
    ]), note(t("GPU·小时 = 调度卡数 × 观测运行时长，含借用一次；配额记账占用率来自平台计数，可能不含池内借用。完整口径见排行页的统计说明。",
      "GPU-hours = scheduled GPUs × observed running time, borrowing counted once; quota-reported utilization comes from platform counters and may exclude pool borrowing. The ranking page documents the full method.")));
  }

  async function quotaDetail(root, m, q) {
    GM.crumb(t("配额 › ", "Quotas › ") + (q.quota_name || q.quota_id), root);
    root.appendChild(back(t("配额列表", "Quotas"), href("quotas")));
    const cap = num(q.gpu_capacity), shown = quotaShown(q), cs = q.cards;
    const linkQuota = (x) => link(x.quota_name || x.quota_id, href("quota", x.quota_id));
    const parentName = q.parent?.quota_name || t("父配额", "the parent quota");
    root.appendChild(el("section", { class: "panel pai-panel pai-q-detail" }, [
      el("div", { class: "pai-detail-title" }, [el("h2", {}, [q.quota_name || q.quota_id]),
        el("span", { class: "pai-chip muted" }, [q.isRoot ? t("根配额", "Root quota") : t("子配额", "Subquota")]),
        q.status && q.status !== "Ready" ? chip(q.status) : null, ...quotaFlags(q)]),
      el("div", { class: "pai-q-detail-grid" }, [
        metaList([
          [t("配额 ID", "Quota ID"), el("span", { class: "mono" }, [q.quota_id])],
          q.parent ? [t("父配额", "Parent"), linkQuota(q.parent)] : null,
          q.children.length ? [t("子配额", "Subquotas"), el("span", { class: "pai-inline" }, q.children.map(linkQuota))] : null,
          [t("已分配 / 容量", "Allocated / capacity"), el("span", { class: "pai-q-cap-line" }, [el("b", { class: "mono" }, [`${gpus(shown)} / ${gpus(cap)}`]), quotaBar(q)])],
          q.hasBreakdown ? [t("分配构成（当前）", "Allocation (current)"), t(`本配额任务 ${gpus(q.self_allocated_gpu)} · 子配额 ${gpus(q.descendants_allocated_gpu)} · 父配额任务占用 ${gpus(q.ancestors_allocated_gpu)}`,
            `This quota ${gpus(q.self_allocated_gpu)} · subquotas ${gpus(q.descendants_allocated_gpu)} · parent-quota workloads ${gpus(q.ancestors_allocated_gpu)}`)] : null,
          [t("绑定节点", "Bound nodes"), t(`${q.nodesTotal} 个 · 可接新任务 ${q.nodesSchedulable} 个`, `${q.nodesTotal} · ${q.nodesSchedulable} schedulable`)],
          [t("物理卡", "Physical GPUs"), t(`${cs.total} 张 · 本配额任务 ${cs.self} · 父配额任务 ${cs.ancestor} · 借出 ${cs.lent} · 原配额空闲 ${cs.free} · 未知 ${cs.unknown}`,
            `${cs.total} · this quota ${cs.self} · parent-quota ${cs.ancestor} · lent out ${cs.lent} · quota-idle ${cs.free} · unknown ${cs.unknown}`)],
          q.oversold_enabled != null ? [t("闲时共享", "Idle sharing"), el("span", { class: "pai-inline" }, [
            q.oversold_enabled ? t("开启：本级和子级空闲资源可供闲时任务使用", "On: idle capacity here and below may be used by idle-time workloads") : t("关闭", "Off"), doc("idle")])] : null,
          q.mismatch ? [t("核对", "Check"), el("span", { class: "pai-flag" }, [t(`任务申请 ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "分配" : "用量"} ${gpus(q.reported)}`,
            `Requested ${gpus(q.expected)} ≠ ${q.hasBreakdown ? "allocated" : "used"} ${gpus(q.reported)}`)])] : null,
        ]),
        el("div", { class: "pai-q-detail-side" }, [
          miniMetrics([
            [t("运行任务", "Running"), String(q.running.length)], [t("排队", "Queued"), String(q.queued.length)],
            [t("用户", "Users"), String(q.users.length)], [t("任务占用 GPU", "Task GPUs"), gpus(q.scheduledGpu)],
            [t("其中借入", "Borrowed in"), gpus(q.borrowingGpu)], [t("节点计算均值", "Node compute"), pct(q.nodeComputeMean)],
            [t(`计算<${LOW}% 卡`, `GPUs <${LOW}%`), String(q.lowDims)], [t("原配额空闲卡", "Quota-idle GPUs"), String(cs.free)],
          ]),
          quotaStrip(q),
        ]),
      ]),
      q.ancestorJobs.length ? note(t(`${q.ancestorJobs.length} 个父配额任务跑在本配额节点上，占 ${cs.ancestor} 卡；它们按提交配额计入 ${parentName} 的用量，这里按实际落点列出。`,
        `${q.ancestorJobs.length} parent-quota workloads run on this quota's nodes (${cs.ancestor} GPUs); they count toward ${parentName} by submission and are listed here by placement.`)) : null,
      q.lentJobs.length ? el("div", { class: "pai-note oversold" }, [t(`借出 ${cs.lent} 卡给 ${q.lentJobs.length} 个闲时任务；本配额需要时会被回收。`,
        `${cs.lent} GPUs lent out to ${q.lentJobs.length} idle-time workloads; reclaimed when this quota needs them. `), doc("idle")]) : null,
      q.borrowingJobs.length ? el("div", { class: "pai-note oversold" }, [t(`借入 ${gpus(q.borrowingGpu)} 卡：本配额 ${q.borrowingJobs.length} 个任务正使用其他配额的闲时资源；已计入任务占用，不增加本配额容量。`,
        `Borrowing in ${gpus(q.borrowingGpu)} GPUs: ${q.borrowingJobs.length} of this quota's workloads use idle capacity elsewhere; counted as task GPUs without adding capacity. `), doc("idle")]) : null,
    ]));
    await quotaWeekPanel(root, q);
    if (!root.isConnected) return;
    root.appendChild(panel(t("绑定节点", "Bound nodes"), [
      ...q.unhealthyNodes.flatMap((n) => n.healTasks.map((w) => el("div", { class: "pai-note warn" }, [healText(n, w), " ", link(t("查看任务", "Open workload"), href("workload", w.WorkloadId)), " ", doc("selfHeal")]))),
      q.boundNodes.length ? el("div", { class: "pai-node-grid" }, q.boundNodes.map(nodeTile)) : note(t("该配额没有绑定节点。", "No nodes are bound to this quota.")),
    ], { tools: legend() }));
    root.appendChild(quotaWorkloadsPanel(q));
    root.appendChild(panel(t("用户", "Users"), [quotaUsersTable(q)]));
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
      if (kind === "pods" || kind === "pods-borrowed") return (kind === "pods-borrowed" ? t("闲时 Pod 映射 · ", "Borrowed Pods · ") : t("Pod 映射 · ", "Pods · ")) + (m.nodes.find((n) => n.NodeName === id)?.short || id);
      return { identity: t("身份", "Identity"), nodes: t("节点目录", "Nodes"), workloads: t("任务列表", "Workloads"),
        users: t("用户统计", "Users"), quotas: t("配额", "Quotas"),
        feature_memberships: t("Feature 成员归属", "Feature memberships"), round: t("采集轮次", "Round") }[kind] || name;
    };
    const sources = (m.sources || []).slice().sort((a, b) => (a.state === "ok") - (b.state === "ok") || a.name.localeCompare(b.name));
    const bad = sources.filter((s) => s.state !== "ok").length;
    const r = m.round || {};
    const summary = [t(`采集来源 ${sources.length} 项`, `${sources.length} sources`),
      !sources.length ? t("等待来源，状态未知", "Waiting for sources; status unknown") : bad ? t(`${bad} 项异常`, `${bad} need attention`) : t("全部正常", "all healthy"),
      r.duration_s != null ? t(`上一轮 ${Number(r.duration_s).toFixed(1)} 秒 / ${r.calls} 次调用`, `last round ${Number(r.duration_s).toFixed(1)}s / ${r.calls} calls`) : null,
    ].filter(Boolean).join(" · ");
    const details = el("details", { id: "paiSources", class: "panel pai-sources" + (bad ? " has-bad" : "") }, [
      el("summary", {}, [el("span", { class: "dot" + (sources.length ? (bad ? " yellow" : " green") : "") }), summary]),
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
    const remember = e => { if (!window.LiveDOM?.draft(e.currentTarget)) ui.sourcesOpen = e.currentTarget.open; };
    details._uiEvents = { toggle: remember };
    details.addEventListener("toggle", remember);
    return details;
  }

  // ── 曲线 ───────────────────────────────────────────────
  function cssVar(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function seriesChart(dom, groups) {
    const text = cssVar("--chart-text", "#93a0b4"), ink = cssVar("--ink", "#eef2f8");
    const colors = UI.Palette.seriesColors(groups.filter((g) => !g.mean).length);
    const chart = window.LiveDOM ? LiveDOM.chart(dom) : echarts.init(dom);
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
      if (!GM.refreshFailed?.(host)) PageRecovery.show();
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
  const rankState = { window: "week", dimension: "feature", expanded: false, methodOpen: false, rowDetails: new Set() };
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
  // 拆分项与合计同精度，最后一项取“合计 − 其余项”，保证页面上可见的加法闭合（真实值仍在提示与 CSV）。
  function splitHrs(total, parts) {
    const d = total >= 100 ? 0 : 1, k = 10 ** d;
    const r = parts.map((v) => Math.round((v || 0) * k));
    r[r.length - 1] = Math.max(0, Math.round((total || 0) * k) - r.slice(0, -1).reduce((a, b) => a + b, 0));
    return r.map((n, i) => !n ? (parts[i] > 0 ? (d ? "<0.1" : "<1") : "0") : d ? (n / k).toFixed(1) : n.toLocaleString());
  }
  // 覆盖率可能极小（上线首日约 0.02%），不能显示成 0.0%。
  const share = (v) => v == null ? "—" : v > 0 && v < 0.1 ? "<0.1%" : pct1(v);
  const span = (sec) => {
    const h = Math.floor(sec / 3600), d = Math.floor(h / 24);
    if (!d) return dur(sec);
    return h % 24 ? t(`${d} 天 ${h % 24} 小时`, `${d}d ${h % 24}h`) : t(`${d} 天`, `${d}d`);
  };
  function exportRanking(data, dimension) {
    const feature = dimension === "feature";
    const rows = feature ? [...(data.features || []), ...(data.root_quota ? [data.root_quota] : [])] : data.users || [];
    const fields = feature ? ["quota_id", "quota_name", "is_root", "rank", "direct_gpu_hours", "root_attributed_gpu_hours", "unattributed_gpu_hours", "gpu_hours", "quota_gpu_hours", "borrowed_gpu_hours",
      "capacity_gpu_hours", "used_gpu_hours", "occupancy_pct", "observed_quota_hours", "expected_quota_hours", "absent_quota_hours", "quota_coverage_pct",
      "effective_gpu_hours", "measured_gpu_hours", "hardware_efficiency_pct", "gpu_metric_coverage_pct", "compute_mean", "gpu_memory_mean", "cpu_core_hours", "mem_gib_hours", "workloads",
      "current_capacity_gpu", "current_used_gpu", "current_occupancy_pct", "current_allocated_gpu", "current_ancestor_allocated_gpu", "quota_fresh"]
      : ["user_id", "username", "gpu_hours", "borrowed_gpu_hours", "effective_gpu_hours", "measured_gpu_hours",
        "hardware_efficiency_pct", "gpu_metric_coverage_pct", "compute_mean", "gpu_memory_mean", "cpu_core_hours", "cpu_util_mean", "mem_gib_hours", "ram_util_mean", "workloads"];
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    const metadata = ["window", "timezone", "week_start", "reset_time", "since_local", "until_local", "generated_local", "history_first_hour_local", "truncated", "boundary_estimate", "quota_coverage_basis"];
    const prefix = [data.window, data.timezone, data.week_start, data.reset_time, ...[data.since, data.until, data.generated_at, data.first_hour].map(ts => reportClock(ts, data.timezone)), data.truncated, data.boundary_estimate, data.quota_coverage_basis];
    const clusterFields = ["task_utilization_estimate_pct", "task_occupancy_pct", "task_estimate_coverage_pct", "task_estimate_hours", "task_capacity_gpu_hours", "task_occupied_gpu_hours", "task_effective_gpu_hours", "physical_utilization_pct", "physical_metric_coverage_pct", "scope"];
    metadata.push(...clusterFields.map(k => "cluster_" + k));
    prefix.push(...clusterFields.map(k => data.cluster?.[k]));
    metadata.push("feature_attribution_basis", "feature_attribution_fresh", "feature_attribution_fetched_at", "root_quota_usage_scope", "total_gpu_hours", "total_borrowed_gpu_hours", "user_quota_basis", "unresolved_root_gpu_hours");
    prefix.push(data.feature_attribution?.basis, data.feature_attribution?.fresh, data.feature_attribution?.fetched_at,
      data.root_quota_usage_scope, data.totals?.gpu_hours, data.totals?.borrowed_gpu_hours, data.user_quota_basis,
      data.feature_attribution?.unresolved_root_gpu_hours == null ? null : JSON.stringify(data.feature_attribution.unresolved_root_gpu_hours));
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
    const roots = new Set([data.root_quota?.quota_id, ...(data.features || []).filter((f) => f.is_root).map((f) => f.quota_id)].filter(Boolean).map(String));
    const gone = new Set((data.features || []).filter((f) => f.current_capacity_gpu == null && f.current_used_gpu == null).map((f) => String(f.quota_id)));
    const ids = [...new Set([...(data.features || []).map((f) => String(f.quota_id)),
      ...(data.users || []).flatMap((u) => (u.quotas || []).map((q) => String(q.quota_id)))])].filter((id) => !roots.has(id) && !gone.has(id)).sort();
    const n = FEATURE_HUES.length;
    const map = new Map(ids.map((id, i) => [id, `hsl(${(FEATURE_HUES[i % n] + 17 * Math.floor(i / n)) % 360}, ${light ? 52 : 48}%, ${light ? 44 : 60}%)`]));
    return (id) => (roots.has(String(id)) ? "var(--muted)" : map.get(String(id)) || "var(--faint)");
  }

  // 横向用量条，长度按本榜最大值归一。用户排行：按提交 Quota 分色，斜纹紫为借用。
  // Feature 排行：实色为直接提交，描边浅色为根配额归属，灰色为根配额未归属；借用是总量子集，画在下方细条，不另占长度。
  function usageBar(parts, max) {
    return el("div", { class: "pai-rank-bar" }, parts.filter((p) => p.v > 0).map((p) => el("i", {
      class: p.idle ? "idle" : p.cls || null, title: p.title || null,
      style: `width:${Math.max(0.8, p.v / max * 100)}%` + (p.color ? `;--c:${p.color}` : "") })));
  }
  function usageCell(total, idle, parts, max, sum, opts = {}) {
    if (total == null) return el("span", { class: "pai-dash", title: t("该窗口无任务历史", "No task history in this window") }, ["—"]);
    return el("div", { class: "pai-rank-usage" }, [
      el("div", { class: "pai-rank-usage-top" }, [
        el("b", {}, [hrs(total)]),
        idle > 0 ? el("span", { class: "idle", title: OVERSOLD_TIP() }, [t(`借用 ${hrs(idle)}`, `${hrs(idle)} borrowed`)]) : null,
        sum > 0 ? el("span", { class: "share", title: t("占全局合计（每个任务只计一次）", "Share of the global total (each task counted once)") }, [share(total / sum * 100)]) : null,
      ]),
      usageBar(parts, max),
      opts.strip > 0 ? el("div", { class: "pai-rank-sub", title: t(`其中借用 ${hrs(opts.strip)} GPU·h，已含在总量内`, `${hrs(opts.strip)} GPU-h borrowed, already included in the total`) },
        [el("i", { style: `width:${Math.max(0.8, opts.strip / max * 100)}%` })]) : null,
      ...(opts.extra || []),
    ]);
  }
  // 与用量条同色的来源图例：[class, 标签, GPU·h, 提示]
  const sourceLine = (items) => el("div", { class: "pai-rank-src" }, items.map(([cls, label, text, title]) =>
    el("span", { class: cls, title: title || null }, [el("i"), label, el("b", {}, [text])])));
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
    sub: total ? t(`指标覆盖 ${share((measured || 0) / total * 100)}`, `${share((measured || 0) / total * 100)} measured`) : null,
    title: total ? t(`指标覆盖 ${rankNumber(measured)} / ${rankNumber(total)} GPU·小时；有效 GPU·小时按单卡计算利用率加权`,
      `Metrics cover ${rankNumber(measured)} / ${rankNumber(total)} GPU-hours; effective GPU-hours are weighted by compute`) : null });
  // 没有任务历史时顺序没有意义，名次显示为 “—”。
  const rankBadge = (rank, live) => el("span", { class: "pai-rank-no" + (rank != null && rank <= 3 && live ? " top" : "") }, [rank == null ? "—" : String(rank)]);
  const rankHead = (cols) => el("thead", {}, [el("tr", {}, cols.map(([label, cls, title]) =>
    el("th", { class: cls, scope: "col", title: title || null }, [label])))]);
  const rankTd = (cols) => (i, child) => el("td", { class: cols[i][1], "data-label": cols[i][0] }, [child]);

  // Native disclosures work with touch and keyboard; keep the user's choice across refreshes.
  function rowDetails(row, dimension, children = []) {
    const key = `${dimension}:${row.quota_id ?? row.user_id}`;
    const name = dimension === "feature" ? row.quota_name : row.username;
    const info = [
      [t("指标覆盖 / 占用 GPU·小时", "Measured / occupied GPU-hours"), `${rankNumber(row.measured_gpu_hours)} / ${rankNumber(row.gpu_hours)}`],
      [t("有效计算 GPU·小时", "Effective GPU-hours"), row.measured_gpu_hours ? rankNumber(row.effective_gpu_hours) : "—"],
    ];
    if (dimension === "feature") info.push(
      [t("配额用量 / 容量 GPU·小时", "Quota used / capacity GPU-hours"), `${rankNumber(row.used_gpu_hours)} / ${rankNumber(row.capacity_gpu_hours)}`],
      [t("配额观测时长 / 覆盖率", "Quota observation hours / coverage"), `${rankNumber(row.observed_quota_hours)} h / ${share(row.quota_coverage_pct)}`]);
    else info.push([t("CPU 核·小时", "CPU core-hours"), rankNumber(row.cpu_core_hours)],
      [t("内存 GiB·小时", "RAM GiB-hours"), rankNumber(row.mem_gib_hours)]);
    if (dimension === "feature" && row.expected_quota_hours != null) info.push(
      [t("应观测时长 / 已排除不存在时长", "Expected hours / excluded absence"), `${rankNumber(row.expected_quota_hours)} h / ${rankNumber(row.absent_quota_hours)} h`]);
    return el("details", { class: "pai-rank-row-details", open: rankState.rowDetails.has(key) ? "" : null,
      ontoggle: e => { if (e.target.isConnected && !window.LiveDOM?.draft(e.target)) e.target.open ? rankState.rowDetails.add(key) : rankState.rowDetails.delete(key); } }, [
      el("summary", { "aria-label": `${name || ""} · ${t("用量详情", "Usage details")}`,
        onclick: e => { e.currentTarget.parentElement.open ? rankState.rowDetails.delete(key) : rankState.rowDetails.add(key); } }, [t("用量详情", "Usage details")]),
      el("div", { class: "pai-rank-detail-body" }, [...children, metaList(info)]),
    ]);
  }

  // 只标两类值得周报关注的情况；阈值写在提示里，不替代原始数字。
  function rankFlags(r, quota) {
    const flags = [];
    if (quota && !r.is_root && r.occupancy_pct != null && r.occupancy_pct >= RANK_FULL) flags.push(el("span", { class: "pai-rank-flag full",
      title: t(`窗口配额占用率 ≥ ${RANK_FULL}%：配额基本用满，排队或闲时任务可能增多`, `Quota occupancy ≥ ${RANK_FULL}%: the quota is nearly saturated`) }, [t("接近满额", "Near full")]));
    if (r.gpu_hours > 0 && r.measured_gpu_hours > 0 && r.hardware_efficiency_pct != null && r.hardware_efficiency_pct < RANK_IDLE) flags.push(el("span", { class: "pai-rank-flag low",
      title: t(`占用期间计算效率 < ${RANK_IDLE}%：占着 GPU 但计算很少`, `Compute while occupied < ${RANK_IDLE}%: GPUs held with little compute`) }, [t("计算偏低", "Low compute")]));
    return flags;
  }

  const UNRESOLVED = { no_feature_role: ["无 Feature 角色", "no feature role"], multiple_features: ["匹配多个 Feature", "multiple features"],
    membership_unavailable: ["成员数据不可用", "membership unavailable"] };

  // 排名 Feature 与根配额同表两组：列宽对齐，根配额单独成组、不给名次。
  function featureTable(data) {
    const rows = data.features || [];
    const root = data.root_quota;
    const rootName = root?.quota_name || "training";
    // 成员角色不可用时没有执行归属：显示 “—” 而不是 0，避免被读成真实结果。
    const attrOk = !!data.feature_attribution?.fresh;
    const paused = t("成员角色不可用，暂未执行归属", "Member roles unavailable; attribution not run");
    const sum = data.totals?.gpu_hours || 0;
    const max = Math.max(0, ...[...rows, root].map((r) => r?.gpu_hours || 0)) || 1;
    const cols = [["#", "c-rank"], ["Feature", "c-name"],
      [t("占用 GPU·小时", "Occupied GPU-hours"), "c-usage", t(`调度卡数 × 运行时长。实色为直接提交，描边浅色为从 ${rootName} 归入的部分，下方紫色细条为其中借用；百分比为占全局合计`,
        `Scheduled GPUs × running time. Solid is direct submissions, outlined is attributed from ${rootName}, the purple strip below is the borrowed subset; % is the share of the global total`)],
      [t("配额记账占用率", "Quota-reported utilization"), "c-metric", t("窗口内已观测配额用量 ÷ 同期配额容量（GPU·小时），API 记账可能不含池内借用", "Observed quota usage ÷ capacity over the window (GPU-hours); API counters may exclude pool borrowing")],
      [t("占用期间计算效率", "Compute while occupied"), "c-metric c-compute", t("按已观测 GPU 时间加权的计算利用率，缺测不计零", "Compute utilization weighted by measured GPU time; missing metrics are not zero")],
      [t("当前用量 / 配额", "Current used / quota"), "c-metric", t("最新配额快照（卡），与所选时间窗无关", "Latest quota snapshot (GPUs), independent of the window")],
      [t("任务", "Jobs"), "c-jobs num"]];
    const td = rankTd(cols);
    const row = (r) => {
      const idle = r.oversold_gpu_hours || 0, cap = r.current_capacity_gpu;
      const inSnapshot = cap != null || r.current_used_gpu != null;
      // 各行覆盖率通常与资源池相同，只在明显不同的行单独提示。
      const ownCoverage = r.quota_coverage_pct != null && r.quota_coverage_pct < 99 &&
        (!root || Math.abs(r.quota_coverage_pct - (root.quota_coverage_pct || 0)) > 1);
      const coverageDetail = r.expected_quota_hours == null ? "" : t(
        `；应观测 ${rankNumber(r.expected_quota_hours)} 小时，已排除配额不存在的 ${rankNumber(r.absent_quota_hours)} 小时；采集失败仍计缺测`,
        `; ${rankNumber(r.expected_quota_hours)} expected hours, excluding ${rankNumber(r.absent_quota_hours)} hours of known absence; collection failures remain missing`);
      const occTitle = t(`已观测用量 ${rankNumber(r.used_gpu_hours)} / 容量 ${rankNumber(r.capacity_gpu_hours)} GPU·小时；观测 ${rankNumber(r.observed_quota_hours)} 小时，覆盖 ${share(r.quota_coverage_pct)}`,
        `Observed used ${rankNumber(r.used_gpu_hours)} / capacity ${rankNumber(r.capacity_gpu_hours)} GPU-hours; ${rankNumber(r.observed_quota_hours)} hours observed, ${share(r.quota_coverage_pct)} coverage`) + coverageDetail;
      const occSub = r.is_root ? t("资源池整体，含子配额", "Whole pool, incl. children")
        : r.expected_quota_hours === 0 ? t("该窗口内配额不存在", "Quota absent throughout this window")
        : ownCoverage ? (r.quota_coverage_pct > 0 ? t(`仅覆盖 ${share(r.quota_coverage_pct)}`, `Only ${share(r.quota_coverage_pct)} covered`) : t("该窗口无配额历史", "No quota history in this window"))
        : null;
      const now = !inSnapshot ? meterCell(null, { sub: t("不在当前配额列表", "Not in current quotas") })
        : meterCell(r.current_occupancy_pct, { text: `${gpus(r.current_used_gpu)} / ${gpus(cap)}`, always: true, cls: data.quota_fresh ? null : "stale",
          sub: data.quota_fresh ? null : t("快照陈旧", "Stale snapshot"),
          subTone: data.quota_fresh ? null : "warn",
          title: t(`最新快照；资源上已分配 ${rankNumber(r.current_allocated_gpu)} 卡，其中祖先配额任务占用 ${rankNumber(r.current_ancestor_allocated_gpu)} 卡。这不是闲时借用来源信息，也不是本 feature 的任务用量。`,
            `Latest snapshot; ${rankNumber(r.current_allocated_gpu)} GPUs allocated, including ${rankNumber(r.current_ancestor_allocated_gpu)} used by ancestors. This is neither idle-time donor information nor feature task usage.`) });
      const direct = r.direct_gpu_hours ?? r.gpu_hours, via = r.root_attributed_gpu_hours || 0;
      let parts, extra = [];
      if (r.is_root) {
        const lost = r.unattributed_gpu_hours ?? Math.max(0, (r.gpu_hours || 0) - via);
        const reasons = Object.entries(data.feature_attribution?.unresolved_root_gpu_hours || {}).filter(([, v]) => v > 0);
        parts = [{ v: via, cls: "via", title: t(`已归入 Feature ${hrs(via)} GPU·h（同时计入上方对应行）`, `${hrs(via)} GPU-h attributed to features (also counted in their rows)`) },
          { v: lost, cls: "unattr", title: t(`未归属 ${hrs(lost)} GPU·h`, `${hrs(lost)} GPU-h unattributed`) }];
        const [viaText, lostText] = splitHrs(r.gpu_hours, [via, lost]);
        if (r.gpu_hours != null) extra.push(sourceLine([["via", t("已归入 Feature", "To features"), attrOk ? viaText : "—", attrOk ? null : paused],
          ["unattr", t("未归属", "Unattributed"), lostText]]));
        const why = splitHrs(lost, reasons.map(([, v]) => v));
        if (reasons.length) extra.push(el("small", { class: "pai-rank-why" }, [t("未归属原因：", "Why unattributed: ") +
          reasons.map(([k], i) => `${UNRESOLVED[k] ? t(...UNRESOLVED[k]) : k} ${why[i]}`).join(" · ")]));
      } else {
        parts = [{ v: direct, title: t(`直接提交 ${hrs(direct)} GPU·h`, `${hrs(direct)} GPU-h submitted directly`) },
          { v: via, cls: "via", title: t(`从 ${rootName} 归入 ${hrs(via)} GPU·h`, `${hrs(via)} GPU-h attributed from ${rootName}`) }];
        const [viaText, directText] = splitHrs(r.gpu_hours, [via, direct]);
        if (r.gpu_hours != null) extra.push(sourceLine([["direct", t("直接提交", "Direct"), directText],
          ["via", t(`从 ${rootName} 归入`, `From ${rootName}`), attrOk ? viaText : "—", attrOk ? null : paused]]));
      }
      const detail = rowDetails(r, "feature", extra);
      detail.querySelector("summary").hidden = true;
      const detailId = `feature-detail-${encodeURIComponent(r.quota_id)}`;
      detail.id = detailId;
      const toggle = el("button", { type: "button", class: "pai-feature-toggle",
        "aria-label": `${r.quota_name} · ${t("展开详情", "Toggle details")}`,
        "aria-controls": detailId, "aria-expanded": String(detail.open),
        onclick: () => {
          const current = UI.live(detail);
          current.open = !current.open;
          UI.live(toggle).setAttribute("aria-expanded", String(current.open));
          const key = `feature:${r.quota_id}`;
          current.open ? rankState.rowDetails.add(key) : rankState.rowDetails.delete(key);
        } }, [el("span", { "aria-hidden": "true" }, ["▸"])]);
      return el("tr", { "data-refresh-key": r.quota_id, class: ["pai-feature-row", r.is_root ? "root" : "", r.gpu_hours ? "" : "zero"].join(" ").trim(),
        onclick: e => {
          if (e.target.closest("button, a, input, select, textarea, summary, .pai-rank-detail-body") || window.getSelection()?.toString()) return;
          UI.live(toggle).click();
        } }, [
        td(0, r.is_root ? null : rankBadge(r.rank, r.gpu_hours > 0 && attrOk)),
        td(1, el("div", { class: "pai-rank-name" }, [toggle, el("div", {}, [
          el("b", { title: r.quota_name }, [r.quota_name]),
          r.is_root ? el("small", {}, [t("根配额 · 仅直接提交", "Root quota · direct submissions")])
            : !inSnapshot ? el("small", {}, [t("历史配额，已不在当前列表", "Historical quota, no longer listed")]) : null]),
          ...rankFlags(r, true)])),
        td(2, usageCell(r.gpu_hours, idle, parts, max, sum, { strip: idle, extra: [
          r.is_root ? el("small", { class: "pai-rank-unattributed" }, [t(`未归属 ${hrs(r.unattributed_gpu_hours)} GPU·h`, `${hrs(r.unattributed_gpu_hours)} GPU-h unattributed`)]) : null,
          detail,
        ].filter(Boolean) })),
        td(3, meterCell(r.occupancy_pct, { title: occTitle, sub: occSub, subTone: ownCoverage && r.quota_coverage_pct < 50 ? "warn" : null })),
        td(4, computeCell(r.hardware_efficiency_pct, r.measured_gpu_hours, r.effective_gpu_hours, r.gpu_hours)),
        td(5, now),
        td(6, r.workloads == null ? "—" : String(r.workloads)),
      ]);
    };
    return el("table", { class: "pai-rank-table feature" }, [rankHead(cols),
      el("tbody", { class: "ranked" }, rows.map(row)),
      root ? el("tbody", { class: "unranked" }, [
        el("tr", { class: "group" }, [el("th", { colspan: String(cols.length), scope: "rowgroup" }, [
          el("span", { class: "pai-rank-chip" }, [t("根配额 · 不参与排名", "Root quota · unranked")]),
          el("span", {}, [t("部分用量已计入上方 Feature", "Some usage is also counted in the features above")])])]),
        row(root)]) : null]);
  }

  function userTable(data, colorOf, rows) {
    const all = data.users || [];
    const sum = all.reduce((a, u) => a + (u.gpu_hours || 0), 0);
    const max = Math.max(0, ...all.map((u) => u.gpu_hours || 0)) || 1;
    const cols = [["#", "c-rank"], [t("用户", "User"), "c-name"],
      [t("占用 GPU·小时", "Occupied GPU-hours"), "c-usage", t("调度卡数 × 运行时长。彩色分段按原始提交 Quota，斜纹为池内借用；百分比为占本窗口合计", "Scheduled GPUs × running time, split by submission Quota; hatched is borrowing within the owned pool; % is the share of the window total")],
      [t("占用期间计算效率", "Compute while occupied"), "c-metric c-compute", t("按已观测 GPU 时间加权的计算利用率，缺测不计零", "Compute utilization weighted by measured GPU time; missing metrics are not zero")],
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
      return el("tr", { "data-refresh-key": u.user_id, class: u.gpu_hours ? null : "zero" }, [
        td(0, rankBadge(i + 1, u.gpu_hours > 0)),
        td(1, el("div", { class: "pai-rank-name" }, [el("div", {}, [
          link(u.username, href("user", u.user_id)),
          tags.length ? el("span", { class: "pai-rank-tags" }, [...tags.slice(0, 3).map((q) => el("span", { title: q.quota_name }, [
            el("i", { style: `--c:${colorOf(q.quota_id)}` }), q.quota_name])), tags.length > 3 ? el("span", {}, ["+" + (tags.length - 3)]) : null]) : null]), ...rankFlags(u, false)])),
        td(2, usageCell(u.gpu_hours, u.oversold_gpu_hours || 0, parts, max, sum, { extra: [rowDetails(u, "user")] })),
        td(3, computeCell(u.hardware_efficiency_pct, u.measured_gpu_hours, u.effective_gpu_hours, u.gpu_hours)),
        td(4, meterCell(u.gpu_memory_mean, { text: pct(u.gpu_memory_mean) })),
        td(5, meterCell(u.cpu_util_mean, { text: pct(u.cpu_util_mean) })),
        td(6, meterCell(u.ram_util_mean, { text: pct(u.ram_util_mean) })),
        td(7, String(u.workloads ?? "—")),
      ]);
    }))]);
  }

  // 本窗口汇总：两种维度共用。资源池口径取根配额（容量含全部子配额）。
  function rankSummary(data) {
    const fs = data.features || [];
    const root = data.root_quota;
    const cluster = data.cluster || {};
    const current = data.current_pool || {};
    const known = data.totals?.gpu_hours != null;
    const add = (k) => data.totals?.[k] || 0;
    const total = known ? add("gpu_hours") : null, idle = add("oversold_gpu_hours");
    const measured = add("measured_gpu_hours"), effective = add("effective_gpu_hours");
    const users = (data.users || []).filter((u) => u.gpu_hours > 0).length;
    const stat = (label, value, subs, extra, cls) => el("div", { class: "pai-rank-stat" + (cls ? " " + cls : "") }, [
      el("span", {}, [label]), el("b", {}, [value]), extra || null, ...subs.filter(Boolean)]);
    const small = (text, tone) => el("small", { class: tone || null }, [text]);
    const meter = (v) => v == null ? null : el("span", { class: "meter" }, [el("i", { style: `width:${Math.max(0, Math.min(100, v))}%` })]);
    const cover = root ? root.quota_coverage_pct : null;
    return el("div", { class: "pai-rank-stats" }, [
      stat(t("占用 GPU·小时合计", "Total occupied GPU-hours"), hrs(total), [total == null ? small(t("该窗口无任务历史", "No task history in this window"))
        : small(t(`其中借用 ${hrs(idle)}`, `${hrs(idle)} borrowed`))],
        total ? usageBar([{ v: total - idle, color: "var(--accent)" }, { v: idle, idle: true }], total) : null, "total"),
      stat(t("集群 GPU 利用率（估算）", "Pool GPU utilization (est.)"), pct1(cluster.task_utilization_estimate_pct), [
        small(t(`时间覆盖 ${share(cluster.task_estimate_coverage_pct)}`, `${share(cluster.task_estimate_coverage_pct)} coverage`)),
        cover != null && cover < 95 ? small(t(`配额覆盖不足 ${share(cover)}`, `${share(cover)} quota coverage`), "warn") : null], meter(cluster.task_utilization_estimate_pct)),
      stat(t("占用期间计算效率", "Compute while occupied"), measured ? pct1(effective / measured * 100) : "—", [
        small(t(`指标覆盖 ${total ? share(measured / total * 100) : "—"}`, `${total ? share(measured / total * 100) : "—"} measured`))]),
      stat(t("当前池占用（任务）", "Current pool occupancy (tasks)"), current.capacity_gpu != null ? `${gpus(current.occupied_gpu)} / ${gpus(current.capacity_gpu)}` : "—", [
        current.fresh ? small(t(`其中借用 ${gpus(current.borrowed_gpu)}`, `${gpus(current.borrowed_gpu)} borrowed`))
          : small(t("快照陈旧或采集失败", "Snapshot stale or failed"), "warn")], meter(current.occupancy_pct), current.fresh ? null : "stale"),
      rankState.dimension === "user"
        ? stat(t("活跃用户", "Active users"), known ? String(users) : "—", [
          known ? small(`${plural(fs.filter((f) => f.gpu_hours > 0).length, "个活跃 Feature", "active feature")} · ${plural(add("workloads"), "个任务", "job")}`) : null])
        : stat(t("活跃 Feature", "Active features"), known ? String(fs.filter((f) => !f.is_root && f.gpu_hours > 0).length) : "—", [
          known ? small(`${plural(users, "位用户", "user")} · ${plural(add("workloads"), "个任务", "job")}`) : null]),
    ]);
  }

  function rankNotices(data) {
    const root = data.root_quota;
    const out = [];
    if (data.first_hour == null || data.first_hour >= data.until) out.push(["warn", t("该窗口尚无任务观测历史，任务用量显示为“—”，不代表零使用。", "No task history was observed in this window; usage shows “—”, not zero.")]);
    if (rankState.dimension === "feature" && root && !root.quota_coverage_pct) out.push(["", t("该窗口没有配额历史，配额占用率未知。", "No quota history in this window; occupancy is unknown.")]);
    if (!data.quota_fresh) out.push(["warn", t("当前配额快照陈旧或采集失败，“当前”数值仅供参考。", "The current quota snapshot is stale or failed; current values are for reference only.")]);
    if (data.truncated) out.push(["warn", t("结果达到上限，表格与导出只含已返回的数据。", "Results are truncated; the table and export contain only returned rows.")]);
    const nodes = out.map(([tone, text]) => note(text, "pai-note " + tone));
    if (rankState.dimension === "feature" && data.root_quota && !data.feature_attribution?.fresh) {
      const a = data.feature_attribution || {};
      const reason = a.state === "stale" ? t("成员归属已过期", "Member attribution is stale")
        : a.state === "error" ? t("成员归属读取失败", "Member attribution could not be read") : t("成员归属尚未就绪", "Member attribution is not ready");
      nodes.push(el("div", { class: "pai-note pai-rank-warning warn", role: "status" }, [
        el("span", {}, [reason + t("，排行暂仅含直接提交。", "; ranking temporarily includes direct submissions only.")]),
        el("button", { type: "button", class: "pai-rank-detail-link", onclick: () => {
          const detail = document.querySelector(".pai-rank-method");
          if (detail) { rankState.methodOpen = true; detail.open = true; detail.querySelector("summary").focus(); }
        } }, [t("查看详情", "Details")]),
      ]));
    }
    return nodes.length ? el("div", { class: "pai-rank-notices" }, nodes) : null;
  }

  // Full attribution context belongs inside the reporting disclosure; failures also get a visible short notice.
  function attributionNote(data) {
    const a = data.feature_attribution || {};
    const name = data.root_quota?.quota_name || "training";
    const when = a.fetched_at ? minuteClock(a.fetched_at, data.timezone) : null;
    const lead = a.fresh ? t(`Feature 用量 = 直接提交 + 从 ${name} 归入。`, `Feature usage = direct + attributed from ${name}.`)
      : a.state === "stale" ? t(`成员角色快照陈旧，${name} 任务暂不归入 Feature。`, `Member roles are stale; ${name} tasks are not attributed to features.`)
      : a.state === "error" ? t(`成员角色读取失败，${name} 任务暂不归入 Feature。`, `Member roles could not be read; ${name} tasks are not attributed to features.`)
      : t(`暂无成员角色数据，${name} 任务暂不归入 Feature。`, `No member role data yet; ${name} tasks are not attributed to features.`);
    const body = a.fresh
      ? t(`提交到 ${name} 的任务，只在提交者当前工作空间角色唯一匹配一个 Feature 时计入；无匹配或匹配多个时保留为未归属，不均分。`,
        `A task submitted to ${name} counts toward a feature only when the submitter's current workspace roles uniquely match one feature; otherwise it stays unattributed and is never split.`)
      : t(`Feature 目前只含直接提交，${name} 用量全部保留为未归属；数据恢复后按当前角色重新计算。`,
        `Features currently show direct submissions only, and all ${name} usage stays unattributed. It is recalculated with current roles once data recovers.`);
    const meta = [
      el("span", { class: "key" }, [t("历史窗口同样按当前角色重算，不代表任务运行时的角色", "Past windows are recalculated with current roles, not the roles at run time")]),
      el("span", {}, [t(`${name} 行与 Feature 有重叠，请勿相加`, `The ${name} row overlaps the features; do not add them up`)]),
      el("span", { class: "mono", title: a.error ? t(`错误：${a.error}`, `Error: ${a.error}`) : null }, [
        when ? t(`成员归属更新时间 ${when}（${reportZone(data)}）`, `Member attribution updated ${when} (${reportZone(data)})`) : t("成员归属尚未成功更新", "Member attribution has not been updated successfully")]),
    ];
    return el("div", { class: "pai-note pai-rank-attr " + (a.fresh ? "info" : "warn") }, [
      el("p", {}, [el("b", {}, [lead]), " ", body]), el("div", { class: "pai-rank-attr-meta" }, meta)]);
  }

  function rankMethod(dimension, data) {
    const items = dimension === "feature" ? [
      t("直接提交子 Quota 的任务归属该 Feature；提交根 Quota 的任务，通过 RAM UserId 对应的当前工作空间自定义角色和配额 allowedRoles，唯一匹配后额外归入 Feature。无匹配、多 Feature 或身份数据失效时保留未归属，不均分、不重复分配。", "Child submissions belong to that feature. Root submissions also count toward the unique feature matched by RAM UserId, current workspace custom roles and quota allowedRoles. Missing, ambiguous or stale membership stays unattributed."),
      t("根配额单列且不参与排名，其任务小时仍为直接提交量；与 Feature 归属用量重叠。全局合计每个任务只计一次。历史按当前角色重算，不代表任务运行时的历史角色。父子配额容量不可相加。", "The root is unranked and retains direct task hours, overlapping feature attribution. Global totals count each task once. History uses current roles, not historical membership. Parent/child capacities must not be added."),
      t("GPU·小时 = 调度卡数 × 采集器观测到的运行时长（每轮约 2 分钟，长间隔最多计两倍降级周期，失败快照不累加）。借用作为总占用的子集，计入团队和个人 GPU 时间；提交 Quota 的原有计数可能不包含它。", "Occupied GPU-hours = scheduled GPUs × observed running time (≈2-min rounds, long gaps capped, failed snapshots add nothing). Borrowing is part of occupied GPU time, not extra pool capacity; submission-quota counters may exclude it."),
      t("配额占用率 = 已观测配额用量 GPU·小时 ÷ 同期配额容量 GPU·小时，API 记账可能不含池内借用；配额变更按观测时长加权。根配额的用量含全部子配额，而它的任务小时只含直接提交。", "Quota occupancy = observed used GPU-hours ÷ capacity GPU-hours over the same intervals, API counters may exclude pool borrowing; changes are time-weighted. Root usage includes children, root task hours only direct submissions."),
      t("配额历史从启用该统计起积累，任务 GPU·小时沿用已有历史，两者覆盖区间可能不同。", "Quota history starts when this report was enabled; task-hour history can be longer."),
      t("计算效率 = 有效计算 GPU 时间 ÷ 有指标的占用 GPU 时间；每卡分钟样本最多代表 60 秒，缺测不外推为整小时。“当前用量 / 配额”是最新快照。", "Compute efficiency = effective GPU time / measured occupied GPU time; each per-card minute sample represents at most 60 seconds, never a whole missing hour. “Current used / quota” is the latest snapshot."),
      t("页面数值按显示精度四舍五入，同一行内的拆分已对齐合计；跨行相加可能有少量尾差，精确值见 CSV。", "Figures are rounded for display. Splits within a row add up to its total; sums across rows may be off slightly. The CSV keeps exact values."),
    ] : [
      t("归属为任务提交者（RAM Owner），不代表共享容器内的逐进程使用人。", "Attribution is the submitter (RAM owner), not processes inside shared containers."),
      t("GPU·小时 = 调度卡数 × 采集器观测到的运行时长；用户用量条保留原始提交 Quota 分段，斜纹为闲时借用（自有资源）。", "Occupied GPU-hours = scheduled GPUs × observed running time; user bars retain submission Quota segments, hatched is borrowing within the owned pool."),
      t("有效 GPU·小时按单卡计算利用率加权；CPU、内存为申请量 × 时长，利用率为占 Pod limit 的百分比。缺测不计零。", "Effective GPU-hours are compute-weighted; CPU and RAM are requested amounts × time, utilization is relative to the Pod limit. Missing metrics are unknown."),
    ];
    items.push(t("集群估算 = 监控工作空间任务的计算 GPU 时间 ÷ 同期物理池容量 GPU 时间。包含自有池借用，只使用任务和单卡指标完整、数量不超过物理容量的观测段；与总窗口的时间覆盖分别展示。普通与闲时 Pod 映射未确认时，不能将对应物理卡判为空闲。计算利用率不是 FLOPS 或训练吞吐效率。",
      "Pool estimate = monitored workspace effective GPU time / physical pool capacity GPU time over the same valid intervals. Borrowing is included once. Only complete, capacity-consistent observations contribute; time coverage is separate. GPUs cannot be declared idle until regular and borrowed Pod mappings are confirmed. GPU utilization is not FLOPS or training throughput efficiency."));
    items.push(t(`每周起点：${weekRule(data)}。历史按 UTC 小时汇总，保留 32 天；周界未对齐 UTC 整点时，边界小时按重叠时长估算。CSV 包含时区、周界、分母和覆盖率。`,
      `Weeks start ${weekRule(data)}. History uses UTC-hour buckets, kept for 32 days; partial boundary hours are estimated by overlap. CSV includes timezone, week rule, denominators and coverage.`));
    return el("details", { class: "pai-rank-method", open: rankState.methodOpen ? "" : null,
      ontoggle: (e) => { if (e.target.isConnected && !window.LiveDOM?.draft(e.target)) rankState.methodOpen = e.target.open; } }, [
      el("summary", { onclick: e => { rankState.methodOpen = !e.currentTarget.parentElement.open; } }, [t("统计说明与数据详情", "How it is computed · data details")]),
      dimension === "feature" && data.root_quota ? attributionNote(data) : null,
      el("div", { class: "pai-rank-report-data" }, [metaList([
        [t("报表生成时间", "Report generated"), `${minuteClock(data.generated_at, data.timezone)} (${reportZone(data)})`],
        [t("集群观测时长", "Pool observation hours"), `${rankNumber(data.cluster?.task_estimate_hours)} h`],
        [t("配额观测时长 / 覆盖率", "Quota observation hours / coverage"), `${rankNumber(data.root_quota?.observed_quota_hours)} h / ${share(data.root_quota?.quota_coverage_pct)}`],
        [t("指标覆盖 / 占用 GPU·小时", "Measured / occupied GPU-hours"), `${rankNumber(data.totals?.measured_gpu_hours)} / ${rankNumber(data.totals?.gpu_hours)}`],
        [t("有效计算 GPU·小时", "Effective GPU-hours"), data.totals?.measured_gpu_hours ? rankNumber(data.totals.effective_gpu_hours) : "—"],
      ])]),
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
      items.push(el("span", { title: OVERSOLD_TIP() }, [el("i", { class: "idle" }), t("其中借用", "Borrowed subset")]));
    } else {
      const name = data.root_quota?.quota_name || "training";
      items.push(el("span", {}, [el("i", {}), t("直接提交", "Direct")]),
        el("span", {}, [el("i", { class: "via" }), t(`从 ${name} 归入`, `Attributed from ${name}`)]),
        el("span", {}, [el("i", { class: "unattr" }), t("未归属", "Unattributed")]),
        el("span", { title: OVERSOLD_TIP() }, [el("i", { class: "strip" }), t("其中借用", "Borrowed subset")]));
    }
    const provisional = rankState.dimension === "feature" && data.root_quota && !data.feature_attribution?.fresh;
    items.push(provisional ? el("span", { class: "sort warn", title: t("成员角色不可用，排序暂不含根配额归属", "Member roles unavailable; the order excludes root attribution") },
      [t("临时排序：仅按直接提交 GPU·小时", "Provisional order: direct GPU-hours only")])
      : el("span", { class: "sort" }, [t("按 GPU·小时降序", "Sorted by GPU-hours")]));
    return el("div", { class: "pai-rank-legend" }, items);
  }

  function rankContent(data, failed, redraw) {
    const dim = rankState.dimension, w = data?.window || rankState.window;
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
      el("div", { class: "pai-rank-heading" }, [el("div", { class: "pai-rank-title" }, [
        el("h3", {}, [dim === "feature" ? t("Feature 排行", "Feature ranking") : t("用户排行", "User ranking")]),
        dim === "feature" && data?.root_quota && !data.feature_attribution?.fresh ? el("span", { class: "pai-rank-degraded", title: t("成员角色快照陈旧或读取失败，根配额任务暂不归入 Feature", "Member roles are stale or unavailable; root tasks are not attributed") },
          [t("归属降级", "Attribution degraded")]) : null]), range]),
      controls]);
    if (failed) return [head, note(t("排行读取失败", "Failed to load ranking"))];
    if (!data) return [head];
    const colorOf = featureColors(data);
    const rows = dim === "feature" ? data.features || [] : data.users || [];
    const body = [rankSummary(data), rankNotices(data)];
    if (!rows.length && !(dim === "feature" && data.root_quota)) body.push(el("div", { class: "pai-rank-empty" }, [t("该时间窗内还没有记录。", "No records in this window yet.")]));
    else {
      const shown = dim === "user" && !rankState.expanded ? rows.slice(0, RANK_PAGE) : rows;
      const known = dim === "feature" ? data.totals?.gpu_hours != null : rows.some((r) => r.gpu_hours != null);
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
    const draw = () => UI.live(box).replaceChildren(...rankContent(data, failed, draw));
    draw();
    host.appendChild(box);
    try { data = await API.paiRanking(rankState.window); } catch (e) {
      if (!host.isConnected) return;
      if (!GM.refreshFailed?.(host)) PageRecovery.show();
      failed = true; draw();
      return;
    }
    if (!host.isConnected) return;
    draw();
  }

  function metaList(items, cls) {
    return el("dl", { class: "pai-meta" + (cls ? " " + cls : "") }, items.filter(Boolean).flatMap(([k, v]) => [el("dt", {}, [k]), el("dd", {}, [v])]));
  }

  function miniMetrics(items) {
    return el("div", { class: "pai-mini" }, items.map(([k, v]) => el("div", { class: "mini-metric" }, [el("span", {}, [k]), el("b", {}, [v])])));
  }

  return { el, t, ui, LOW, isLow, num, pct, pct1, gpus, ago, clock, href, link, note, chip, typeChip, bar, prepare, cell, card, legend,
    header, slimHeader, kpis, taskMeanHint, clusterMeanHint, estimateMetric, tabs, panel, back, heatPanel, nodesPanel, workloadsPanel, workloadsTable, usersTable, quotasPanel, quotasTab, quotaDetail,
    sourcesPanel, docsPanel, queueBanner, healText, rankingPanel, strategyText, specText, dur, doc, oversoldChip, stateCell, nodeChips, OVERSOLD_TIP, drawSeries, metaList, miniMetrics, rangeText, conflictFlag };
})();

// ── 首页：两个平台入口，各自显示来源新鲜度，不合并统计 ─────────────
Views.home = { async render(root) {
  const { el, t, note, chip, pct, ago } = PaiUI;
  GM.crumb(t("首页", "Home"), root);
  const stat = (k, v, hint) => el("div", { class: "mini-metric", title: hint || null }, [el("span", {}, [k]), el("b", {}, [v])]);
  const shell = (cls, eyebrow, title, desc, path, go) => {
    const body = el("div", { class: "home-body" }, [note(t("读取中…", "Loading…"))]);
    const status = el("div", { class: "home-status" });
    const card = el("section", { class: "home-card " + cls }, [
      el("div", { class: "home-card-head" }, [el("div", {}, [el("div", { class: "eyebrow" }, [eyebrow]), el("h2", {}, [el("a", {class:"home-main-link",href:"#"+path}, [title])]), note(desc)]), status]),
      body,
      el("div", { class: "home-foot" }, [el("a", { class: "home-go", href:"#"+path }, [go])]),
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
      if (!raw.nodes) { GM.refreshFailed?.(root); pai.status.replaceChildren(chip(raw.state)); pai.body.replaceChildren(note(t("暂无快照", "No snapshot yet"))); return; }
      const m = PaiUI.prepare(raw), s = m.sx;
      pai.status.replaceChildren(...[chip(m.state), el("small", {}, [ago(m.updatedAt)]),
        s.queued.length ? el("span", { class: "pai-chip " + (s.unschedulable.length ? "bad" : "warn") },
          [t(`排队 ${s.queued.length}`, `${s.queued.length} queued`) + (s.unschedulable.length ? t(`（${s.unschedulable.length} 可能排不上）`, ` (${s.unschedulable.length} at risk)`) : "")]) : null].filter(Boolean));
      GM.setSourceHealth("pai", m.state, m.updatedAt, root);
      pai.body.replaceChildren(
        el("div", { class: "home-stats" }, [
          stat(t("已分配 / 物理卡", "Allocated / physical"), `${m.summary.mapped_gpus ?? "—"} / ${s.physical}`),
          PaiUI.estimateMetric(m, "home"),
          stat(t("计算均值（任务）", "Compute mean (tasks)"), pct(m.summary.task_compute_mean), PaiUI.taskMeanHint(m.summary)),
          stat(t("运行任务", "Running"), String(s.running)),
        ]),
        stripOf(m.cardsFlat.map((c) => c.state === "free" ? "free" : c.compute ? c.compute.value : null)),
        note([t(`每格一张物理卡（${s.physical}）。`, `One square per physical GPU (${s.physical}). `),
          s.oversoldGpu ? t(`闲时任务占用 ${s.oversoldGpu} 卡，已确认物理映射 ${s.borrowedMapped} 卡；属于图中自有池容量，不额外增加卡数。`, `Idle-time tasks occupy ${s.oversoldGpu} GPUs; ${s.borrowedMapped} have confirmed physical mappings. They belong to the owned pool and add no capacity. `) : "",
          s.unmapped.length ? t(`${s.unmapped.length} 个配额内任务未关联到节点。`, `${s.unmapped.length} in-quota workloads lack node mapping.`) : ""].join("")),
      );
    }).catch(() => { if (root.isConnected) { if (!GM.refreshFailed?.(root)) PageRecovery.show(); pai.status.replaceChildren(chip("error")); pai.body.replaceChildren(note(t("PAI 快照读取失败", "Failed to read PAI snapshot"))); } }),
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
    }).catch(() => { if (root.isConnected) { if (!GM.refreshFailed?.(root)) PageRecovery.show(); bare.status.replaceChildren(chip("error")); bare.body.replaceChildren(note(t("裸金属数据读取失败", "Failed to read bare-metal data"))); } }),
  ]);
}};

// ── PAI 模块 ───────────────────────────────────────────────
Views.pai = { async render(root, params) {
  const P = PaiUI;
  const { el, t, note, chip, href } = P;
  const tabName = { overview: t("总览", "Overview"), quotas: t("配额", "Quotas"), nodes: t("节点", "Nodes"), workloads: t("任务", "Workloads"), users: t("用户", "Users"), ranking: t("排行", "Ranking") };
  GM.crumb(tabName[params.tab] || "PAI", root);
  const raw = await API.paiOverview();
  if (!root.isConnected) return;
  root.classList.add("pai-scope");
  if (!raw.nodes) {
    GM.refreshFailed?.(root);
    GM.setSourceHealth("pai", raw.state, null, root);
    root.appendChild(el("section", { class: "panel pai-empty-state" }, [el("h3", {}, ["PAI"]), chip(raw.state),
      note(raw.state === "waiting" ? t("采集器尚未完成首轮采集。", "The collector has not finished its first round.") : t("PAI 模块未启用。", "The PAI module is disabled."))]));
    return;
  }
  const m = P.prepare(raw);
  GM.setSourceHealth("pai", m.state, m.updatedAt, root);
  const tab = params.tab || "overview";
  const activeTab = { node: "nodes", workload: "workloads", user: "users", quota: "quotas" }[tab] || tab;
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
    // 窄屏总览只展示摘要：前 5 位用户与前 5 个任务，其余通过各自标签页查看。
    const narrow = !!window.matchMedia?.("(max-width: 760px)").matches;
    const userLimit = narrow ? 5 : null;
    root.appendChild(P.heatPanel(m));
    root.appendChild(el("div", { class: "grid2 pai-grid2" }, [
      P.panel(t("用户", "Users"), [P.usersTable(m.users, true, userLimit),
        userLimit && m.users.length > userLimit ? el("a", { class: "pai-more", href: href("users") }, [t(`查看全部 ${m.users.length} 位用户 →`, `All ${m.users.length} users →`)]) : null],
      { tools: P.link(t("详情 →", "Details →"), href("users"), "pai-more") }),
      P.quotasPanel(m),
    ]));
    root.appendChild(P.workloadsPanel(m, { limit: narrow ? 5 : 8 }));
  } else if (tab === "ranking") {
    await P.rankingPanel(root);
    if (!root.isConnected) return;
  } else if (tab === "quotas") {
    root.appendChild(P.quotasTab(m));
  } else if (tab === "quota") {
    const q = (m.quotas || []).find((x) => x.quota_id === params.id);
    if (!q) root.appendChild(P.panel(t("配额未找到", "Quota not found"), [note(t("该配额不在当前快照中。", "This quota is not in the current snapshot.")), P.back(t("配额列表", "Quotas"), href("quotas"))]));
    else {
      await P.quotaDetail(root, m, q);
      if (!root.isConnected) return;
    }
  } else if (tab === "nodes") {
    root.appendChild(P.nodesPanel(m));
  } else if (tab === "node") {
    const n = m.nodes.find((x) => x.NodeName === params.id);
    const avgOf = (cards, metric) => { const xs = cards.map((c) => c[metric]).filter((x) => x && x.fresh).map((x) => x.value); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    if (!n) root.appendChild(P.panel(t("节点未找到", "Node not found"), [P.back(t("节点列表", "Nodes"), href("nodes"))]));
    else {
      GM.crumb(t("节点 › ", "Nodes › ") + n.short, root);
      const byId = Object.fromEntries(m.workloads.map((w) => [w.WorkloadId, w]));
      const rows = n.cards.flatMap((c) => (c.assignments.length ? c.assignments : [null]).map((a) => [c, a]));
      root.appendChild(P.back(t("节点列表", "Nodes"), href("nodes")));
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [el("h2", { class: "mono" }, [n.short]), ...P.nodeChips(n)]),
        P.metaList([[t("完整名称", "Full name"), el("span", { class: "mono" }, [n.NodeName])], [t("型号", "Model"), `${n.GPUType || "—"} · ${P.gpus(n.GPU)} GPU`],
          [t("所属配额", "Quota"), n.quotaIds.length ? el("span", { class: "pai-inline" }, n.quotaIds.map((id, i) => P.link(n.quotaNames[i], href("quota", id)))) : "—"],
          [t("可分配 / 普通请求", "Allocatable / regular requests"), el("span", {
            title: t("节点原始请求计数可能不包含闲时借用；全部已定位占用见下项。", "The node request counter may exclude idle borrowing; all mapped allocation is shown below.")
          }, [`${P.gpus(n.AllocatableGPU)} / ${P.gpus(n.RequestGPU)}`])],
          [t("已定位占用 / 其中借用", "Mapped allocation / borrowed subset"), el("span", {
            title: t("按物理 GPU 卡号去重，借用是已定位占用的子集；陈旧映射仅作上次关联展示。", "Deduplicated by physical GPU index; borrowing is a subset of mapped allocation. Stale mappings show the last known assignment.")
          }, [`${n.assigned} / ${n.cards.filter((c) => c.borrowed).length}`,
            n.cards.some((c) => c.assignments.some((a) => !a.fresh)) ? el("small", { class: "pai-low" }, [t(" · 含上次关联", " · includes last seen")]) : null])],
          [t("节点状态", "Node state"), el("span", { class: "pai-inline" }, [chip(n.NodeStatus),
            n.healthPct != null ? el("span", {}, [t("健康度 ", "Health ") + Math.round(n.healthPct) + "%"]) : null,
            n.ReasonCode ? el("span", { class: "mono" }, [n.ReasonCode + (n.ReasonMessage ? " · " + n.ReasonMessage : "")]) : null,
            n.unhealthy || n.NodeStatus !== "Ready" ? P.doc("manageQuota", t("节点状态说明", "Node states")) : null,
            n.unhealthy ? P.doc("selfHeal") : null])],
          [t("Pod 映射", "Pod mapping"), chip(n.mapping_state)], [t("未见占用的卡", "No visible allocation"), String(n.free)]], "cols2"),
        ...n.healTasks.map((w) => el("div", { class: "pai-note warn" }, [P.healText(n, w), " ", P.link(t("查看任务", "Open workload"), href("workload", w.WorkloadId)), " ", P.doc("selfHeal")])),
        P.legend(),
        // 单卡行右侧放节点摘要，利用宽屏空间；窄屏自然换行到下方。
        el("div", { class: "pai-node-detail-row" }, [
          el("div", { class: "cards pai-cards-lg" }, n.cards.map((c) => P.card(c, { href: c.assignments[0] ? href("workload", c.assignments[0].workload_id) : null }))),
          P.miniMetrics([[t("计算均值", "Compute"), P.pct(avgOf(n.cards, "compute"))], [t("显存均值", "Memory"), P.pct(avgOf(n.cards, "memory"))],
            [t("有近期值的卡", "GPUs with data"), `${n.cards.filter((c) => c.compute?.fresh).length} / ${n.cards.length}`],
            [t(`计算<${P.LOW}% 卡`, `GPUs <${P.LOW}%`), String(n.cards.filter((c) => c.low).length)],
            [t("借入卡", "Borrowed in"), String(n.cards.filter((c) => c.borrowed).length)], [t("原配额空闲", "Quota idle"), String(n.free)]]),
        ]),
      ]));
      root.appendChild(P.panel(t("单卡归属", "Card assignments"), [el("div", { class: "pai-table-scroll" }, [el("table", { class: "pai-table compact" }, [
        el("thead", {}, [el("tr", {}, ["GPU", t("任务", "Workload"), "Owner", t("计算", "Compute"), t("显存", "Memory"), t("源采样", "Sampled")].map((h) => el("th", {}, [h])))]),
        el("tbody", {}, rows.map(([c, a]) => {
          const w = a && byId[a.workload_id];
          return el("tr", {}, [
            el("td", { "data-label": "GPU", class: "mono" }, ["#" + c.index]),
            el("td", { "data-label": t("任务", "Workload") }, [a ? P.link(w?.WorkloadName || a.workload_id, href("workload", a.workload_id)) : el("span", { class: "pai-muted" }, [c.state === "free" ? t("未见占用", "No allocation seen") : t("未知", "Unknown")]),
              a?.borrowed === true ? P.oversoldChip(t("闲时借用", "Idle borrowing")) : null,
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
      GM.crumb(t("用户 › ", "Users › ") + u.Username, root);
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [el("h2", {}, [u.Username]), P.conflictFlag(u)]),
        P.miniMetrics([[t("运行任务", "Running"), P.gpus(u.running_workloads)], [t("申请 GPU", "Requested GPU"), P.gpus(u.submitted_gpu)],
          [t("配额统计用量", "Quota-counted usage"), P.gpus(u.used_gpu)], [t("已映射物理卡", "Mapped GPUs"), String(u.mapped)],
          [t("当前占用 GPU", "Occupied GPUs"), P.gpus(u.quotaUse.reduce((sum, q) => sum + q.gpus, 0))],
          [t("其中：池内借用 GPU", "Of which: borrowed GPUs"), P.gpus(u.oversoldGpu)],
          [t("计算均值", "Compute"), P.pct(u.compute)], [t("显存均值", "Memory"), P.pct(u.memory)], [t(`计算<${P.LOW}% 卡`, `GPUs <${P.LOW}%`), String(u.low)]]),
        u.oversoldGpu ? el("div", { class: "pai-note oversold" }, [t(
          `其中 ${P.gpus(u.oversoldGpu)} 卡为自有池内借用，已计入当前占用，不增加池容量。已确认的物理节点与 GPU 卡号见任务详情；配额记账可能不含借用，原 Quota 需要时任务暂停、释放资源并重新等待。`,
          `${P.gpus(u.oversoldGpu)} borrowed GPUs are included in occupied GPUs without adding pool capacity. Workload details show confirmed nodes and GPU indices. Quota counters may exclude borrowing; workloads pause, release GPUs and requeue when reclaimed. `), P.doc("idle")]) : null,
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
      GM.crumb(t("任务 › ", "Workloads › ") + w.WorkloadName, root);
      const pods = [...new Set(w.gpus.map((g) => g.pod))];
      const dimCard = (g) => ({ index: g.gpu, assignments: [], state: g.compute ? "measured" : "assigned",
        compute: g.compute && { value: g.compute.value, sampled_at: g.compute.ts, fresh: g.compute.fresh, recent: g.compute.recent_mean, recent_n: g.compute.recent_n },
        memory: g.memory && { value: g.memory.value, sampled_at: g.memory.ts, fresh: g.memory.fresh },
        stale: !!(g.compute && !g.compute.fresh), low: P.isLow(g.compute) });
      const scheduled = P.num(w.scheduled_gpu), requested = P.num(w.requested_gpu);
      root.appendChild(el("section", { class: "panel pai-panel" }, [
        el("div", { class: "pai-detail-title" }, [P.typeChip(w.WorkloadType), el("h2", {}, [w.WorkloadName]), P.stateCell(w), w.oversold ? P.oversoldChip() : null]),
        P.metaList([
          ["Owner", P.link(w.UserName, href("user", w.UserId))], [t("配额", "Quota"), w.QuotaId ? P.link(w.quota, href("quota", w.QuotaId)) : w.quota],
          [t("申请 / 调度 GPU", "Requested / scheduled"), `${P.gpus(requested)} / ${P.gpus(scheduled)}`],
          [t("资源来源", "Capacity"), w.oversold
            ? el("span", { class: "pai-inline" }, [P.oversoldChip(t("闲时借用（自有资源）", "Borrowed (owned pool)")),
              el("span", { class: "pai-muted" }, [t("不新增容量/费用；原 Quota 需要时暂停、释放资源并重新等待", "No additional capacity/charges; paused and requeued when reclaimed")]), P.doc("idle")])
            : el("span", {}, [w.queued ? t("排队中，尚未分配", "Queued, not yet allocated") : t("配额内", "Inside the quota")])],
          [t("优先级", "Priority"), w.priority != null ? el("span", { class: "pai-inline" }, [String(w.priority), P.doc("preempt", t("抢占规则", "Preemption"))]) : "—"],
          w.WorkloadType === "dlc" ? [t("提交策略", "Idle-resource policy"), w.job
            ? el("span", { class: "pai-inline" }, [el("span", {}, [P.strategyText(w.strategy)]), P.doc("idle")])
            : el("span", { class: "pai-muted" }, [t("任务详情尚未取得", "Job detail not fetched yet")])] : null,
          w.WorkloadType === "dlc" && w.job ? [t("自动容错", "Fault tolerance"), el("span", { class: "pai-inline" }, [
            w.job.aimaster == null ? t("AIMaster 状态未知", "AIMaster unknown") : w.job.aimaster ? t("已开启 AIMaster", "AIMaster on") : t("未开启 AIMaster", "AIMaster off"),
            w.oversold && w.job.aimaster === false ? el("small", { class: "pai-low" }, [t("借用资源被收回时暂停并重新等待；业务恢复进度取决于作业配置", "Borrowing pauses and requeues after reclaim; workload recovery depends on its configuration")]) : null])] : null,
          w.specs.length ? [t("Pod 规格", "Pod spec"), w.specs.map(P.specText).join("；")] : null,
          [t("CPU / 内存申请", "Requested CPU / RAM"), [w.requested_cpu != null ? t(`${P.gpus(w.requested_cpu)} 核`, `${P.gpus(w.requested_cpu)} cores`) : "—",
            w.requested_mem_gib != null ? `${P.gpus(Math.round(w.requested_mem_gib))} GiB` : "—"].join(" / ")],
          [t("物理节点", "Node"), w.nodes.length ? el("span", {}, w.nodes.flatMap((n, i) => [i ? ", " : null,
            P.link(n.short, href("node", n.name), "mono"), " · GPU " + P.rangeText(n.indices)]))
            : el("span", { class: "pai-muted" }, [w.oversold ? t("闲时 Pod 映射尚未确认", "Borrowed Pod mapping not yet confirmed")
              : w.metrics.length ? t("未关联（有单卡指标）", "Unmapped (has GPU metrics)") : "—"])],
          [t("任务 ID", "Workload ID"), el("span", { class: "mono" }, [w.WorkloadId])],
        ], "cols2"),
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
