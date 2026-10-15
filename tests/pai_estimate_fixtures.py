"""Synthetic backend snapshots for the JavaScript estimate explanation contract."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from gpumon.pai.collector import normalize_metrics
from gpumon.pai.config import PaiSettings
from gpumon.pai.store import PaiStore
from gpumon.pai.view import overview


def fixture(name, *, status=None, measured=8, stale_pods=False, stale_nodes=False,
            stale_workloads=False, capacity=16, expected=8, conflict=False, shared=False,
            unlisted=False, metric_error=False, zero=False, scheduled=True, nodes_error=False):
    cfg = PaiSettings(enabled=True, account_id="123", workspace_id="work", quota_id="quota")
    with tempfile.TemporaryDirectory() as temporary:
        store = PaiStore(Path(temporary) / "pai.db")
        store.initialize()
        jobs = [{"WorkloadId": "running", "WorkloadName": "Running sample", "WorkloadStatus": "Running",
                 "requested_gpu": expected, "scheduled_gpu": expected, "scheduled": scheduled}]
        pods = [{"WorkloadId": "running", "PodName": "pod", "GPUIndexes": list(range(min(8, capacity))), "Phase": "Running"}]
        if status or unlisted:
            if not unlisted:
                jobs.append({"WorkloadId": "transition", "WorkloadName": "Transition sample", "WorkloadStatus": status,
                             "requested_gpu": 8, "scheduled_gpu": 8, "scheduled": True})
            pods.append({"WorkloadId": "transition", "PodName": "transition-pod", "GPUIndexes": list(range(8, 16)), "Phase": "Running"})
        if shared:
            pods.append({"WorkloadId": "running", "PodName": "second-pod", "GPUIndexes": [0], "Phase": "Running"})
        store.save("nodes", [{"NodeName": "node", "GPU": capacity, "RequestGPU": min(capacity, 8)}], now=1 if stale_nodes else 960)
        if nodes_error:
            store.failure("nodes", "timeout", now=990)
        store.save("workloads", jobs, now=1 if stale_workloads else 960)
        store.save("pods:node", pods, now=1 if stale_pods else 960)
        store.save("pods-borrowed:node", [{**pods[0], "GPUIndexes": [1]}] if conflict else [], now=960)
        store.save("metric:running:compute", [{"sampled_at": 900}], now=960)
        store.put_metrics(normalize_metrics([{"jobId": "running", "pod": "pod", "gpu": str(i), "timestamp": 900,
                                              "Value": 0 if zero else 50} for i in range(measured)], cfg, "running", "compute", 960), 0)
        if metric_error:
            store.failure("metric:running:compute", "timeout", now=990)
        store.save("round", {"ok": True}, now=960)
        result = overview(store, cfg, 1000)
        store.close()
        return {"name": name, "raw": result}


if __name__ == "__main__":
    cases = [
        (fixture("saving_and_missing", status="Saving", measured=6), ["missing_compute", "non_running_allocations"]),
        (fixture("saving_all_metrics", status="Saving"), ["non_running_allocations"]),
        (fixture("stopping_all_metrics", status="Stopping"), ["non_running_allocations"]),
        (fixture("unscheduled", scheduled=False), ["non_running_allocations"]),
        (fixture("retained_saving", status="Saving", stale_pods=True), ["retained_allocations"]),
        (fixture("missing", measured=6), ["missing_compute"]),
        (fixture("extra", measured=9), ["extra_compute"]),
        (fixture("unknown", expected=None), ["unknown_gpu_count"]),
        (fixture("nodes_stale", stale_nodes=True), ["source_unavailable"]),
        (fixture("nodes_error", nodes_error=True), ["source_unavailable"]),
        (fixture("workloads_stale", stale_workloads=True), ["source_unavailable"]),
        (fixture("metric_error", metric_error=True), ["missing_compute"]),
        (fixture("capacity_empty", capacity=0, expected=0, measured=0), ["capacity_unknown"]),
        (fixture("over_capacity", capacity=4), ["over_capacity"]),
        (fixture("conflict", conflict=True), ["mapping_conflict"]),
        (fixture("shared", shared=True), ["shared_cards"]),
        (fixture("unlisted", unlisted=True), ["unlisted_allocations"]),
        (fixture("normal_zero", zero=True), []),
        (fixture("normal"), []),
        (fixture("stale_mapping_only", stale_pods=True), []),
    ]
    for case, reasons in cases:
        case["expected_reasons"] = reasons
        assert (case["raw"]["summary"]["pool_compute_estimate"] is None) == bool(reasons), case["name"]
    print(json.dumps([case for case, _ in cases]))
