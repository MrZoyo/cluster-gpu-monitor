"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(root, "web/js/pai-estimate.js"), "utf8"), context);
const explain = (raw) => JSON.parse(JSON.stringify(context.window.PaiEstimate.explain(raw)));
const localPython = path.join(root, ".venv/bin/python");
const python = process.env.GPUMON_TEST_PYTHON || (fs.existsSync(localPython) ? localPython : "python3");
const fixtures = JSON.parse(execFileSync(python, [path.join(__dirname, "pai_estimate_fixtures.py")], {
  cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "src") }, encoding: "utf8", timeout: 15000,
}));
for (const { name, raw, expected_reasons: expected } of fixtures) {
  const original = JSON.stringify(raw), result = explain(raw);
  assert.equal(result.available, raw.summary.pool_compute_estimate != null, name);
  assert.deepEqual(result.reasons.map((reason) => reason.code).sort(), [...expected].sort(), name);
  assert.equal(result.measured_gpus, raw.summary.task_measured_gpus, name);
  assert.equal(result.capacity_gpus, raw.summary.physical_gpus, name);
  if (raw.summary.pool_scheduled_gpus != null) assert.equal(result.expected_gpus, raw.summary.pool_scheduled_gpus, name);
  assert.equal(JSON.stringify(raw), original, "Explanation must not mutate the snapshot");
  assert.ok(!("value" in result) && !("pool_compute_estimate" in result), "Explanation must not calculate a replacement estimate");
}
const sample = (name) => fixtures.find((entry) => entry.name === name).raw;
const combined = explain(sample("saving_and_missing"));
assert.equal(combined.reasons.find((reason) => reason.code === "missing_compute").gpus, 2);
assert.equal(combined.reasons.find((reason) => reason.code === "non_running_allocations").gpus, 8);
assert.equal(combined.reasons.find((reason) => reason.code === "non_running_allocations").tasks[0].status, "Saving");
assert.equal(sample("saving_all_metrics").summary.pool_task_metric_coverage_pct, 100);
const retained = explain(sample("retained_saving")).reasons[0];
assert.equal(retained.code, "retained_allocations");
assert.equal(retained.tasks[0].last_status, "Saving");
assert.ok(!("status" in retained.tasks[0]));
assert.match(retained.labelZh, /旧 Pod.*当前状态待确认/);
assert.equal(sample("normal_zero").summary.pool_compute_estimate, 0);
assert.deepEqual(explain(sample("normal_zero")).reasons, []);
const repeated = structuredClone(sample("saving_all_metrics"));
repeated.nodes[0].cards[8].assignments.push({ ...repeated.nodes[0].cards[8].assignments[0] });
assert.equal(explain(repeated).reasons.find((reason) => reason.code === "non_running_allocations").gpus, 8);
// A backend value always wins, even if a future backend version relaxes a gate.
assert.deepEqual(explain({ ...sample("saving_all_metrics"), summary: { pool_compute_estimate: 0 } }).reasons, []);
assert.ok(explain({}).reasons.length > 0);
console.log(`PAI estimate explanations passed (${fixtures.length} synthetic backend fixtures, no replacement estimates).`);
