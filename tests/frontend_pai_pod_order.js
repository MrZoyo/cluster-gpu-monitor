"use strict";
// In-Pod GPU ids paired with physical cards: tooltips say where a value comes from and that the
// per-card position is inferred, the workload page can name the physical card, node tiles list
// who holds which cards, and an allocated card without a value explains why.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/js/pai.js"), "utf8");
function load(locale) {
  const context = vm.createContext({
    UI: { el: (tag, attrs = {}, children = []) => ({ tag, attrs, children }),
      utilColor: () => ({ bg: "#123456" }), ago: () => "now" },
    I18n: { getLocale: () => locale },
  });
  context.window = context;
  vm.runInContext(source, context);
  return context.PaiUI;
}

const metric = (wid, gpu, name, value) => ({ workload_id: wid, pod: wid + "-pod", gpu: String(gpu), metric: name,
  value, ts: 940, fresh: true, recent_mean: value, recent_n: 8 });
// Two 4-GPU workloads on one 8-GPU node: "idle" borrows cards 0-3, "busy" holds 4-7 and reports 0-3.
function fixture(edit = () => {}) {
  const workload = (id, borrowed, first, value) => ({ WorkloadId: id, WorkloadName: id, WorkloadType: "dsw",
    WorkloadStatus: "Running", QuotaId: borrowed ? "b" : "a", UserId: id, UserName: id, scheduled: true,
    scheduled_gpu: 4, requested_gpu: 4, oversold: borrowed,
    cards: [0, 1, 2, 3].map((k) => ({ node: "node", index: first + k })),
    metrics: [0, 1, 2, 3].flatMap((k) => [metric(id, k, "compute", value), metric(id, k, "memory", value)]) });
  const workloads = [workload("idle", true, 0, 0), workload("busy", false, 4, 100)];
  const cards = Array.from({ length: 8 }, (_, index) => {
    const w = workloads[index < 4 ? 0 : 1], v = index < 4 ? 0 : 100;
    const value = () => ({ value: v, fresh: true, recent: v, recent_n: 8, sampled_at: 940, pod_gpu: String(index % 4), by_order: index >= 4 });
    return { index, metric_gap: null, assignments: [{ workload_id: w.WorkloadId, pod: w.WorkloadId + "-pod", owner_id: w.UserId,
      owner_name: w.UserName, fresh: true, borrowed: index < 4 }], compute: value(), memory: value() };
  });
  const raw = { quota_id: "root", state: "ok", now: 1000, sources: [{ name: "nodes", state: "ok" }],
    quotas: [{ quota_id: "root", quota_name: "root", gpu_capacity: 8 },
      { quota_id: "a", quota_name: "a", parent_quota_id: "root", gpu_capacity: 8 },
      { quota_id: "b", quota_name: "b", parent_quota_id: "root", gpu_capacity: 0 }],
    nodes: [{ NodeName: "node", NodeStatus: "Ready", GPU: 8, RequestGPU: 4, bound_quotas: ["root", "a"],
      cards, free_known: true, mapping_state: "ok", mapping_conflict: false, health_rate: 10000 }],
    workloads, users: [], summary: {} };
  edit(raw);
  return raw;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const find = (node, test) => (!node || typeof node !== "object" ? null : test(node) ? node
  : (node.children || []).reduce((hit, child) => hit || find(child, test), null));
const P = load("zh");
const tip = (c, ui = P) => ui.cell(c).attrs.title;
const gpusOf = (m, id) => m.workloads.find((w) => w.WorkloadId === id).gpus;

let m = P.prepare(fixture());
let node = m.nodes[0];
assert.deepEqual(node.cards.map((c) => c.state), Array(8).fill("measured"));
assert.deepEqual(plain(node.holders), [{ name: "idle", borrowed: true, indices: [0, 1, 2, 3], stale: false },
  { name: "busy", borrowed: false, indices: [4, 5, 6, 7], stale: false }]);
assert.deepEqual(plain(gpusOf(m, "busy").map((g) => [g.gpu, g.physical])),
  ["0", "1", "2", "3"].map((gpu, k) => [gpu, { short: "node", index: 4 + k, byOrder: true, fresh: true }]));
assert.equal(gpusOf(m, "idle")[0].physical.byOrder, false);
assert.match(tip(node.cards[5]), /指标取自任务内 GPU 1.*按升序推断/, "A card paired by order names its in-Pod GPU as an inference");
assert.doesNotMatch(tip(node.cards[1]), /任务内 GPU/, "A Pod starting at card 0 needs no pairing note");
assert.doesNotMatch(tip(node.cards[5]), /利用率未知/);
// The node tile keeps showing names only; who holds which cards is on hover.
const who = find(P.heatPanel(m), (x) => String(x.attrs?.class || "").includes("pai-node-who"));
assert.deepEqual(plain(who.children), ["idle · busy"]);
assert.equal(who.attrs.title, "idle · 闲时借用 · GPU 0–3\nbusy · GPU 4–7");
// The workload page names the physical card behind an in-Pod GPU.
const dim = (g) => ({ index: g.gpu, assignments: [], physical: g.physical, state: "measured", compute: { value: 100, fresh: true } });
assert.match(tip(dim(gpusOf(m, "busy")[2])), /物理卡 node · GPU 6（按升序推断）$/m);
assert.doesNotMatch(tip(dim(gpusOf(m, "idle")[2])), /推断|上次关联/);

// A stale placement stays visible but is labelled as the last known association.
m = P.prepare(fixture((raw) => raw.nodes[0].cards.slice(4).forEach((c) => {
  c.assignments[0].fresh = false; c.compute.fresh = c.memory.fresh = false;
})));
assert.match(tip(dim(gpusOf(m, "busy")[0])), /物理卡 node · GPU 4（按升序推断）（上次关联）/);
assert.equal(find(P.heatPanel(m), (x) => String(x.attrs?.class || "").includes("pai-node-who")).attrs.title,
  "idle · 闲时借用 · GPU 0–3\nbusy · GPU 4–7（上次关联）");

// Same owner on a card twice (two Pods) is listed once per card; owners sharing a name stay apart.
m = P.prepare(fixture((raw) => {
  const cards = raw.nodes[0].cards;
  cards[4].assignments.push({ ...cards[4].assignments[0], pod: "busy-pod-2" });
  cards[7].assignments[0] = { ...cards[7].assignments[0], owner_id: "other", owner_name: "busy" };
}));
assert.deepEqual(plain(m.nodes[0].holders.slice(1).map((h) => [h.name, h.indices])), [["busy", [4, 5, 6]], ["busy", [7]]]);

// Allocated without a value: the backend reason code is explained; unknown codes and an older
// backend without the field fall back to a generic reason.
const reasons = { no_metrics: /尚未返回单卡指标/, id_mismatch: /无法一一配对/, placement_conflict: /两种 Pod 视图/,
  invalid_indexes: /无效卡号/, several_nodes: /多个节点/, shared_card: /多个任务关联到同一张卡/,
  future_code: /未返回，或无法与物理卡配对/, [undefined]: /未返回，或无法与物理卡配对/ };
for (const [code, text] of Object.entries(reasons)) {
  m = P.prepare(fixture((raw) => raw.nodes[0].cards.slice(4).forEach((c) => {
    c.compute = c.memory = null;
    if (code === "undefined") delete c.metric_gap; else c.metric_gap = code;
  })));
  node = m.nodes[0];
  assert.deepEqual(node.cards.slice(4).map((c) => c.state), Array(4).fill("assigned"), code);
  assert.equal(P.cell(node.cards[4]).children[0], "—", code);
  assert.match(tip(node.cards[4]), new RegExp("^利用率未知：.*" + text.source, "m"), code);
  assert.equal(gpusOf(m, "busy")[0].physical, null, code);
}

// An older backend sends neither pod_gpu nor by_order: values still render, without pairing claims.
m = P.prepare(fixture((raw) => raw.nodes[0].cards.forEach((c) => {
  for (const key of ["compute", "memory"]) { delete c[key].pod_gpu; delete c[key].by_order; }
  delete c.metric_gap;
})));
assert.deepEqual(m.nodes[0].cards.map((c) => c.state), Array(8).fill("measured"));
assert.doesNotMatch(tip(m.nodes[0].cards[5]), /任务内 GPU|推断/);
assert.ok(m.workloads.every((w) => w.gpus.every((g) => g.physical === null)));

// English copy carries the same meaning.
const E = load("en");
m = E.prepare(fixture((raw) => { raw.nodes[0].cards[0].assignments[0].fresh = false; }));
assert.match(tip(m.nodes[0].cards[5], E), /Metrics from in-Pod GPU 1: .*inferred by ascending order/);
assert.equal(find(E.heatPanel(m), (x) => String(x.attrs?.class || "").includes("pai-node-who")).attrs.title,
  "idle · idle borrowing · GPU 0–3 (last seen)\nbusy · GPU 4–7");
m = E.prepare(fixture((raw) => { const c = raw.nodes[0].cards[6]; c.compute = c.memory = null; c.metric_gap = "several_nodes"; }));
assert.match(tip(m.nodes[0].cards[6], E), /Utilization unknown: the same Pod is listed under several nodes/);

console.log("PAI pod-order pairing checks passed (inference label, stale placement, reason codes, older backend, English).");
