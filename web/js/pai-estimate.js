/* Explain the backend's unavailable estimate; never calculate a replacement value. */
(() => {
  "use strict";
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const gpuCount = (workload) => {
    const value = workload.scheduled_gpu ?? workload.requested_gpu;
    return finite(value) && value >= 0 ? value : null;
  };
  const identity = (workload, id) => ({ id, name: workload?.WorkloadName || id || "" });

  function explain(raw = {}) {
    const summary = raw.summary || {}, workloads = raw.workloads || [], nodes = raw.nodes || [];
    const sources = new Map((raw.sources || []).map((source) => [source.name, source]));
    const fresh = (name) => sources.get(name)?.state === "ok";
    const byWorkload = new Map(workloads.map((workload) => [workload.WorkloadId, workload]));
    const running = [...byWorkload.values()].filter((workload) => workload.WorkloadStatus === "Running" && workload.scheduled !== false);
    const runningIds = new Set(running.map((workload) => workload.WorkloadId));
    // A physical coordinate is counted once, including when several Pods claim it.
    const cards = new Map();
    nodes.forEach((node) => (node.cards || []).forEach((card) => cards.set(JSON.stringify([node.NodeName, card.index]), card)));
    const measured = (workload) => (workload.metrics || []).filter((metric) => metric.metric === "compute" && metric.fresh === true).length;
    const expected = running.reduce((total, workload) => total + (gpuCount(workload) ?? 0), 0);
    const result = {
      available: finite(summary.pool_compute_estimate), reasons: [],
      expected_gpus: expected,
      measured_gpus: fresh("workloads") ? running.reduce((total, workload) => total + measured(workload), 0) : 0,
      capacity_gpus: finite(summary.physical_gpus) ? summary.physical_gpus : null,
    };
    // The backend is authoritative, including a valid zero and future gate changes.
    if (result.available) return result;
    const add = (code, labelZh, labelEn, detail = {}) => result.reasons.push({ code, labelZh, labelEn, ...detail });
    const unavailable = ["nodes", "workloads"].filter((name) => !fresh(name));
    if (unavailable.length) {
      add("source_unavailable", "节点或任务数据读取失败、陈旧或尚未取得", "Node or workload data is failed, stale, or unavailable",
        { sources: unavailable.map((name) => ({ name, state: sources.get(name)?.state || "unknown" })) });
    }
    if (!cards.size) add("capacity_unknown", "物理池容量尚未确认", "Physical pool capacity is not confirmed");

    const missing = [], extra = [], unknown = [];
    running.forEach((workload) => {
      const expectedGpus = gpuCount(workload), measuredGpus = measured(workload);
      const task = { ...identity(workload, workload.WorkloadId), status: workload.WorkloadStatus,
        expected_gpus: expectedGpus, measured_gpus: measuredGpus };
      if (expectedGpus == null) unknown.push(task);
      else if (measuredGpus < expectedGpus) missing.push({ ...task, gpus: expectedGpus - measuredGpus });
      else if (measuredGpus > expectedGpus) extra.push({ ...task, gpus: measuredGpus - expectedGpus });
    });
    if (unknown.length) add("unknown_gpu_count", `${unknown.length} 个运行任务的 GPU 调度量和申请量未知`,
      `GPU allocation and request are unknown for ${unknown.length} running workloads`, { tasks: unknown });
    if (missing.length) {
      const gpus = missing.reduce((total, task) => total + task.gpus, 0);
      add("missing_compute", `运行任务缺少 ${gpus} 卡新鲜计算指标`, `Running workloads lack fresh compute metrics for ${gpus} GPUs`, { gpus, tasks: missing });
    }
    if (extra.length) {
      const gpus = extra.reduce((total, task) => total + task.gpus, 0);
      add("extra_compute", `计算指标比任务调度卡数多 ${gpus} 条，可能正在切换 Pod`,
        `There are ${gpus} more compute metric series than allocated GPUs; Pods may be changing`, { gpus, tasks: extra });
    }

    const groups = new Map(["non_running_allocations", "unlisted_allocations", "retained_allocations"]
      .map((code) => [code, { cards: new Set(), tasks: new Map() }]));
    let shared = 0;
    cards.forEach((card, coordinate) => {
      const assignments = card.assignments || [];
      if (assignments.length > 1) shared += 1;
      assignments.filter((assignment) => !runningIds.has(assignment.workload_id)).forEach((assignment) => {
        const workload = byWorkload.get(assignment.workload_id);
        const code = assignment.fresh !== true || !fresh("workloads") ? "retained_allocations"
          : workload ? "non_running_allocations" : "unlisted_allocations";
        const group = groups.get(code);
        group.cards.add(coordinate);
        const id = assignment.workload_id || assignment.pod || "";
        if (!group.tasks.has(id)) {
          const task = { ...identity(workload, id), cards: new Set() };
          if (code === "retained_allocations") task.last_status = workload?.WorkloadStatus;
          else if (workload) { task.status = workload.WorkloadStatus; task.scheduled = workload.scheduled; }
          group.tasks.set(id, task);
        }
        group.tasks.get(id).cards.add(coordinate);
      });
    });
    for (const [code, group] of groups) {
      const gpus = group.cards.size;
      if (!gpus) continue;
      const tasks = [...group.tasks.values()].map(({ cards: taskCards, ...task }) => ({ ...task, gpus: taskCards.size }));
      const labels = {
        non_running_allocations: [`非运行或未调度任务仍有 ${gpus} 卡映射`, `${gpus} GPUs remain mapped to non-running or unscheduled workloads`],
        unlisted_allocations: [`${gpus} 卡的任务未出现在当前任务列表`, `Workloads mapped to ${gpus} GPUs are absent from the current workload list`],
        retained_allocations: [`保留的旧 Pod 映射涉及 ${gpus} 卡，当前状态待确认`, `Retained Pod mappings cover ${gpus} GPUs; current state is unconfirmed`],
      };
      add(code, ...labels[code], { gpus, tasks });
    }
    if (expected > cards.size) add("over_capacity", `任务调度 ${expected} 卡，超过物理池 ${cards.size} 卡`,
      `Workload allocation of ${expected} GPUs exceeds physical capacity of ${cards.size}`, { gpus: expected - cards.size });
    const conflicts = nodes.filter((node) => node.mapping_conflict === true).map((node) => node.NodeName);
    if (conflicts.length) add("mapping_conflict", `${conflicts.length} 个节点的 Pod 卡号映射存在冲突`,
      `Pod GPU mappings conflict on ${conflicts.length} nodes`, { nodes: conflicts });
    if (shared) add("shared_cards", `${shared} 张物理卡存在重复任务或 Pod 映射`,
      `${shared} physical GPUs have multiple workload or Pod mappings`, { gpus: shared });
    if (!result.reasons.length) add("estimate_unavailable", "当前快照暂不满足后端估算条件", "The current snapshot does not satisfy the backend estimate requirements");
    return result;
  }
  window.PaiEstimate = { explain };
})();
