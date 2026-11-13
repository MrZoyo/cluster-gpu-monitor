"use strict";
// In-Pod GPU ids paired with physical cards: tooltips say where a value comes from,
// the workload page can name the physical card, and node tiles list who holds which cards.
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

const metric = (wid, gpu, name, value) => ({ workload_id: wid, pod: wid + "-pod", gpu: String(gpu), metric: name,
  value, ts: 940, fresh: true, recent_mean: value, recent_n: 8 });
function fixture(paired = true) {
  const workload = (id, borrowed, first, value) => ({ WorkloadId: id, WorkloadName: id, WorkloadType: "dsw",
    WorkloadStatus: "Running", QuotaId: borrowed ? "b" : "a", UserId: id, UserName: id, scheduled: true,
    scheduled_gpu: 4, requested_gpu: 4, oversold: borrowed,
    cards: [0, 1, 2, 3].map((k) => ({ node: "node", index: first + k })),
    metrics: [0, 1, 2, 3].flatMap((k) => [metric(id, k, "compute", value), metric(id, k, "memory", value)]) });
  const workloads = [workload("idle", true, 0, 0), workload("busy", false, 4, 100)];
  const cards = Array.from({ length: 8 }, (_, index) => {
    const w = workloads[index < 4 ? 0 : 1], local = String(index % 4), byOrder = index >= 4;
    const value = (v) => (byOrder && !paired ? null : { value: v, fresh: true, recent: v, recent_n: 8, sampled_at: 940, pod_gpu: local, by_order: byOrder });
    return { index, assignments: [{ workload_id: w.WorkloadId, pod: w.WorkloadId + "-pod", owner_id: w.UserId,
      owner_name: w.UserName, fresh: true, borrowed: index < 4 }], compute: value(index < 4 ? 0 : 100), memory: value(index < 4 ? 0 : 100) };
  });
  return { quota_id: "root", state: "ok", now: 1000, sources: [{ name: "nodes", state: "ok" }],
    quotas: [{ quota_id: "root", quota_name: "root", gpu_capacity: 8 },
      { quota_id: "a", quota_name: "a", parent_quota_id: "root", gpu_capacity: 8 },
      { quota_id: "b", quota_name: "b", parent_quota_id: "root", gpu_capacity: 0 }],
    nodes: [{ NodeName: "node", NodeStatus: "Ready", GPU: 8, RequestGPU: 4, bound_quotas: ["root", "a"],
      cards, free_known: true, mapping_state: "ok", mapping_conflict: false, health_rate: 10000 }],
    workloads, users: [], summary: {} };
}
const P = context.PaiUI;

let m = P.prepare(fixture());
let node = m.nodes[0];
assert.deepEqual(node.cards.map((c) => c.state), Array(8).fill("measured"));
assert.deepEqual(JSON.parse(JSON.stringify(node.holders)), [
  { name: "idle", borrowed: true, indices: [0, 1, 2, 3] }, { name: "busy", borrowed: false, indices: [4, 5, 6, 7] }]);
const busy = m.workloads.find((w) => w.WorkloadId === "busy");
assert.deepEqual(JSON.parse(JSON.stringify(busy.gpus.map((g) => [g.gpu, g.physical]))),
  ["0", "1", "2", "3"].map((gpu, k) => [gpu, { short: "node", index: 4 + k, byOrder: true }]));
assert.equal(m.workloads.find((w) => w.WorkloadId === "idle").gpus[0].physical.byOrder, false);

const tip = (c) => P.cell(c).attrs.title;
assert.match(tip(node.cards[5]), /指标取自任务内 GPU 1/, "A card paired by Pod order names its in-Pod GPU");
assert.doesNotMatch(tip(node.cards[1]), /任务内 GPU/, "A Pod starting at card 0 needs no pairing note");
assert.doesNotMatch(tip(node.cards[5]), /利用率未知/);

// Without a pairing the card stays allocated-but-unknown and the tooltip gives the reason.
m = P.prepare(fixture(false));
node = m.nodes[0];
assert.deepEqual(node.cards.slice(4).map((c) => c.state), Array(4).fill("assigned"));
assert.equal(P.cell(node.cards[4]).children[0], "—");
assert.match(tip(node.cards[4]), /利用率未知：该 Pod 的单卡指标/);
assert.equal(m.workloads.find((w) => w.WorkloadId === "busy").gpus[0].physical, null);

console.log("PAI pod-order pairing checks passed");
