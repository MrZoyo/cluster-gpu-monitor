"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({
  UI: { el: (tag, attrs = {}, children = []) => ({ tag, attrs, children }),
    utilColor: () => ({ bg: "#123456" }), ago: () => "now" },
  I18n: { getLocale: () => "zh" },
});
context.window = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/js/pai.js"), "utf8"), context);

function fixture() {
  const workload = (id, quota, borrowed = false) => ({ WorkloadId: id, WorkloadName: id,
    WorkloadType: "dlc", WorkloadStatus: "Running", QuotaId: quota, UserId: id, UserName: id,
    scheduled: true, scheduled_gpu: 1, requested_gpu: 1, oversold: borrowed,
    cards: [{ node: "node", index: { own: 0, parent: 1, borrower: 2 }[id] }], metrics: [] });
  const workloads = [workload("own", "a"), workload("parent", "root"), workload("borrower", "b", true)];
  const cards = Array.from({ length: 8 }, (_, index) => ({ index, assignments: index < 3 ? [{
    workload_id: workloads[index].WorkloadId, pod: "pod-" + index, fresh: true, borrowed: index === 2,
  }] : [], compute: index < 3 ? { value: 20 + index * 20, fresh: true, recent: 20, recent_n: 8 } : null, memory: null }));
  return { quota_id: "root", state: "ok", now: 1000, sources: [{ name: "nodes", state: "ok" }],
    quotas: [{ quota_id: "root", quota_name: "root", gpu_capacity: 8 },
      { quota_id: "a", quota_name: "a", parent_quota_id: "root", gpu_capacity: 8 },
      { quota_id: "b", quota_name: "b", parent_quota_id: "root", gpu_capacity: 0 }],
    nodes: [{ NodeName: "node", NodeStatus: "Ready", GPU: 8, RequestGPU: 2, bound_quotas: ["root", "a"],
      cards, free_known: true, mapping_state: "ok", mapping_conflict: false, health_rate: 10000 }],
    workloads, users: [], summary: {} };
}
const model = (edit = () => {}) => { const raw = fixture(); edit(raw); return context.PaiUI.prepare(raw); };
const quota = (m, id = "a") => m.quotas.find((q) => q.quota_id === id);
const conserved = (q) => assert.equal(q.cards.self + q.cards.ancestor + q.cards.lent + q.cards.free + q.cards.unknown, q.cards.total);

let m = model(), q = quota(m);
assert.equal(q.cards.self, 1);
assert.equal(q.cards.ancestor, 1);
assert.equal(q.cards.lent, 1);
assert.equal(q.cards.free, 5);
assert.equal(quota(m, "root").cards.total, 8, "Root physical capacity must not add child capacity");
assert.equal(quota(m, "root").scheduledGpu, 3, "Root workload allocations are deduplicated");
assert.equal(q.scheduledGpu, 1, "Parent and foreign workload allocations do not become submitted-here GPUs");
assert.equal(q.relation.get("borrower"), "borrowed");
conserved(q);

for (const status of ["Stopped", "Failed", "Succeeded", "Saving", "Stopping"]) {
  m = model((raw) => {
    raw.workloads[0].WorkloadStatus = status;
    if (!["Saving", "Stopping"].includes(status)) {
      raw.workloads[0].cards = [];
      raw.nodes[0].cards[0].assignments = [];
      raw.nodes[0].cards[0].compute = null;
    }
  });
  q = quota(m);
  assert.equal(q.users.find((user) => user.id === "own").gpus, 0, status);
  assert.equal(q.scheduledGpu, 0, status);
  assert.equal(q.ownRunning.length, 0, status);
  assert.equal(q.cards.self, ["Saving", "Stopping"].includes(status) ? 1 : 0,
    "A fresh transition Pod remains physically mapped without becoming Running allocation");
  conserved(q);
}

for (const problem of ["unlisted", "stale", "conflict", "shared", "nodes_stale", "foreign_unknown"]) {
  m = model((raw) => {
    const card = raw.nodes[0].cards[2];
    if (problem === "unlisted") card.assignments[0].workload_id = "absent";
    if (problem === "stale") { card.assignments[0].fresh = false; card.compute.fresh = false; }
    if (problem === "conflict") raw.nodes[0].mapping_conflict = true;
    if (problem === "shared") card.assignments.push({ workload_id: "parent", pod: "second", fresh: true });
    if (problem === "nodes_stale") raw.sources[0].state = "stale";
    if (problem === "foreign_unknown") { card.assignments[0].borrowed = false; raw.workloads[2].oversold = false; }
  });
  q = quota(m);
  assert.ok(q.cards.unknown >= 1, problem);
  assert.equal(q.cards.lent, 0, problem);
  assert.equal(q.relation.has("borrower"), false, "An unconfirmed foreign placement must not become a current parent/borrower relation: " + problem);
  assert.equal(q.cards.ancestor, ["conflict", "nodes_stale"].includes(problem) ? 0 : 1, problem);
  conserved(q);
}

m = model((raw) => { raw.workloads[2].oversold = false; });
assert.equal(quota(m).relation.get("borrower"), "borrowed", "Fresh explicit borrowed Pod evidence can identify borrowing independently of the workload flag");
assert.equal(quota(m).lentJobs.length, 1);

// Quota strips must preserve the existing stale class, not paint retained metrics as current.
m = model((raw) => { raw.nodes[0].cards[2].assignments[0].fresh = false; raw.nodes[0].cards[2].compute.fresh = false; });
const tree = context.PaiUI.quotasTab(m);
const walk = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(walk)] : [];
const all = walk(tree);
const card = all.find((node) => node.attrs?.href === "#/pai/quota/a" && node.attrs.class?.includes("pai-q-card"));
assert.ok(walk(card).some((node) => node.tag === "i" && node.attrs.class?.split(" ").includes("stale")));
console.log("PAI quota quality checks passed (terminal/transition states, unknown/stale/conflicting placement, borrowing and capacity).");
