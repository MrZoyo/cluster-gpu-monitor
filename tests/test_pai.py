from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi import Response
from fastapi.testclient import TestClient

from gpumon.pai.client import CollectionError, PaiClient
from gpumon.pai.collector import job_row, mem_gib, node_row, normalize_metrics, quota_row, workload_row
from gpumon.pai.config import PaiSettings
from gpumon.pai.store import PaiStore
from gpumon.pai.view import overview


@pytest.fixture
def cfg():
    return PaiSettings(enabled=True, account_id="123", workspace_id="work", quota_id="quota")


@pytest.fixture
def store(tmp_path):
    s = PaiStore(tmp_path / "pai.db")
    s.initialize()
    yield s
    s.close()


def test_pagination_requires_complete_total_and_follows_pages(cfg):
    client = PaiClient(cfg)
    pages = []
    def api(action, path, params):
        pages.append(params["PageNumber"])
        return {"Rows": [{"id": params["PageNumber"]}], "TotalCount": 2}
    client._api = api
    assert client.pages("ListNodes", "/", "Rows") == ([{"id": 1}, {"id": 2}], 2)
    assert pages == [1, 2]
    client._api = lambda *a: {"Rows": [], "TotalCount": 5}
    with pytest.raises(CollectionError, match="incomplete"):
        client.pages("ListNodes", "/", "Rows")


def test_pagination_repetition_and_cap_are_not_success(cfg):
    client = PaiClient(cfg)
    client._api = lambda *a: {"Rows": [{"id": 1}], "TotalCount": 5}
    with pytest.raises(CollectionError, match="pagination_repeated"):
        client.pages("ListNodes", "/", "Rows")
    cfg.max_pages = 1
    with pytest.raises(CollectionError, match="pagination_limit"):
        client.pages("ListNodes", "/", "Rows")


def test_cms_next_token_is_fully_consumed(cfg):
    client = PaiClient(cfg)
    requested = []
    def api(action, path, params, *args):
        requested.append(params)
        return {"Datapoints": json.dumps([{"value": len(requested)}]),
                "NextToken": "next" if len(requested) == 1 else ""}
    client._api = api
    assert len(client.metrics("dlc", "job", "CARD_GPU_DUTY_CYCLE", 1000)) == 2
    assert requested[1]["NextToken"] == "next"
    assert requested[0]["Period"] == 60


def test_failed_source_retains_value_and_timestamp(store):
    store.save("nodes", [{"NodeName": "n"}], now=100)
    store.failure("nodes", "permission_denied", now=200)
    row = store.sources()["nodes"]
    assert row["payload"] == [{"NodeName": "n"}]
    assert row["fetched_at"] == 100
    assert row["attempted_at"] == 200
    assert row["state"] == "error"


def test_late_points_upsert_fixed_120s_buckets_without_double_count(store, cfg):
    def point(ts, value):
        return {"jobId": "job", "pod": "pod", "gpu": "0", "timestamp": ts, "Value": value}
    first = normalize_metrics([point(840, 10), point(900, 30), point(900, 30)], cfg, "job", "compute", 960)
    store.put_metrics(first, 0)
    store.put_metrics(normalize_metrics([point(900, 50)], cfg, "job", "compute", 1000), 0)
    data = store.series("job", 1000)
    assert len(data["points"]) == 1
    p = data["points"][0]
    assert (p["ts"], p["mean"], p["max"], p["count"], p["coverage"]) == (840, 30, 50, 2, 1)
    assert "owner" not in p and "node" not in p


def test_invalid_and_missing_values_never_become_zero(cfg):
    points = [{"jobId": "job", "pod": "p", "gpu": "0", "timestamp": 900, "Value": v}
              for v in [None, -1, 101, float("nan")]]
    assert normalize_metrics(points, cfg, "job", "compute", 960) == []
    assert normalize_metrics([{**points[0], "Value": 0}], cfg, "job", "compute", 960)[0][2] == 0


def seed(store):
    store.save("identity", {"AccountId": "123"}, now=960)
    store.save("nodes", [{"NodeName": "node", "GPU": "2", "GPUType": "Test", "RequestGPU": 1}], now=960)
    store.save("workloads", [{"WorkloadId": "job", "WorkloadName": "job", "WorkloadStatus": "Running",
        "UserId": "person", "UserName": "Alice", "requested_gpu": 1}], now=960)
    store.save("users", [{"UserId": "person", "Username": "Alice", "used_gpu": 0}], now=960)
    store.save("pods:node", [{"WorkloadId": "job", "PodName": "pod", "GPUIndexes": [0], "Phase": "Running"}], now=960)
    store.save("metric:job:compute", [{"sampled_at": 900}], now=960)
    store.save("round", {"ok": True}, now=960)


def test_denominator_owner_and_conflict_are_preserved(store, cfg):
    seed(store)
    store.put_metrics(normalize_metrics([{"jobId": "job", "pod": "pod", "gpu": "0",
        "timestamp": 900, "Value": 42, "userId": "account_not_person"}], cfg, "job", "compute", 960), 0)
    d = overview(store, cfg, 1000)
    expected = {"physical_gpus": 2, "mapped_gpus": 1, "measured_gpus": 1,
                            "metric_denominator": 2, "compute_mean": 42,
                            "task_compute_mean": 42, "task_measured_gpus": 1,
                            "cluster_compute_mean": 21, "cluster_known_gpus": 2,
                            "cluster_unallocated_gpus": 1}
    assert {k: d["summary"][k] for k in expected} == expected
    assert d["summary"]["pool_compute_estimate"] == 21
    assert d["nodes"][0]["cards"][1]["compute"] is None
    assert d["nodes"][0]["cards"][0]["assignments"][0]["owner_id"] == "person"
    assert d["users"][0]["conflict"] is True
    assert overview(store, cfg, 2000)["summary"]["compute_mean"] is None


@pytest.mark.parametrize("failure", ["metric", "pods", "nodes", "workloads", "unmapped"])
def test_cluster_mean_does_not_replace_missing_data_with_zero(store, cfg, failure):
    seed(store)
    store.put_metrics(normalize_metrics([{"jobId": "job", "pod": "pod", "gpu": "0",
        "timestamp": 900, "Value": 100}], cfg, "job", "compute", 960), 0)
    if failure == "unmapped":
        store.save("nodes", [{"NodeName": "node", "GPU": "2", "RequestGPU": 2}], now=960)
    else:
        name = {"metric": "metric:job:compute", "pods": "pods:node"}.get(failure, failure)
        store.failure(name, "unavailable", now=980)
    summary = overview(store, cfg, 1000)["summary"]
    assert summary["cluster_compute_mean"] is None
    assert summary["cluster_known_gpus"] < 2


def test_task_mean_includes_unmapped_idle_gpus_with_equal_per_gpu_weight(store, cfg):
    seed(store)
    workloads = store.sources()["workloads"]["payload"]
    workloads += [{"WorkloadId": "idle", "WorkloadName": "idle", "WorkloadStatus": "Running",
                   "UserId": "person", "requested_gpu": 2, "oversold": True},
                  {"WorkloadId": "queued", "WorkloadName": "queued", "WorkloadStatus": "Running",
                   "UserId": "person", "requested_gpu": 1, "scheduled": False}]
    store.save("workloads", workloads, now=960)
    for wid, values in [("job", [0]), ("idle", [90, 90]), ("queued", [100])]:
        store.save("metric:" + wid + ":compute", [{"sampled_at": 900}], now=960)
        store.put_metrics(normalize_metrics([{"jobId": wid, "pod": "pod", "gpu": str(i),
            "timestamp": 900, "Value": value} for i, value in enumerate(values)], cfg, wid, "compute", 960), 0)
    summary = overview(store, cfg, 1000)["summary"]
    assert summary["task_compute_mean"] == 60  # Three GPUs, not two task averages (45%).
    assert summary["task_measured_gpus"] == 3
    assert summary["cluster_compute_mean"] is None  # Hidden borrowing makes unmapped cards unknown.
    assert summary["cluster_unallocated_gpus"] == 0
    assert summary["pool_compute_estimate"] is None  # Three scheduled GPUs cannot fit this two-GPU pool.
    store.failure("metric:idle:compute", "unavailable", now=980)
    assert overview(store, cfg, 1000)["summary"]["task_measured_gpus"] == 1


def test_unallocated_cluster_is_zero_but_empty_or_stale_cluster_unknown(store, cfg):
    seed(store)
    store.save("workloads", [], now=960)
    store.save("nodes", [{"NodeName": "node", "GPU": "2", "RequestGPU": 0}], now=960)
    store.save("pods:node", [], now=960)
    summary = overview(store, cfg, 1000)["summary"]
    assert summary["cluster_compute_mean"] == 0
    assert summary["cluster_unallocated_gpus"] == 2
    assert summary["task_compute_mean"] is None
    assert overview(store, cfg, 2000)["summary"]["cluster_compute_mean"] is None
    store.save("nodes", [], now=960)
    assert overview(store, cfg, 1000)["summary"]["cluster_compute_mean"] is None


def test_oversold_queue_health_and_allocation_fields_are_kept():
    w = workload_row({"WorkloadId": "job", "Resource": {"GPU": "8"}, "ScheduledResource": {"GPU": "8"},
                      "UseOversoldResource": True, "IsScheduled": "false", "Position": 3, "Priority": 4})
    assert (w["oversold"], w["scheduled"], w["queue_position"], w["requested_gpu"]) == (True, False, 3, 8)
    assert workload_row({"UseOversoldResource": "maybe"})["oversold"] is None
    queued = workload_row({"IsScheduled": False, "Reason": "r" * 400, "Code": "", "CodeType": "QuotaNotEnough",
                           "GmtEnqueuedTime": "2026-10-09T14:46:42Z", "GmtDequeuedTime": None})
    assert (len(queued["queue_reason"]), queued["queue_code"], queued["dequeued_at"]) == (300, "QuotaNotEnough", None)
    assert queued["enqueued_at"] == 1791557202
    assert workload_row({"Reason": "", "GmtEnqueuedTime": "bad"})["queue_reason"] is None
    q = quota_row({"quota_id": "q", "gpu_used": 0, "quota_config": {"oversold_usage_config": {"disabled": False}},
                   "quota_details": {"allocated_quota": {"gpu": 8}, "self_allocated_quota": {"gpu": 0},
                                     "ancestors_allocated_quota": {"gpu": 8}}})
    assert (q["allocated_gpu"], q["self_allocated_gpu"], q["ancestors_allocated_gpu"], q["descendants_allocated_gpu"],
            q["oversold_enabled"]) == (8, 0, 8, None, True)
    assert quota_row({"quota_id": "q"})["oversold_enabled"] is None
    n = node_row({"NodeName": "n", "HealthRate": 0, "ReasonCode": "Recovering", "ReasonMessage": "x" * 500,
                  "BoundQuotas": [{"QuotaId": "root", "QuotaName": "r"}, {"QuotaName": "no id"}],
                  "SelfQuotaWorkloadNum": 1})
    assert (n["health_rate"], n["bound_quotas"], len(n["ReasonMessage"])) == (0, ["root"], 200)
    assert "SelfQuotaWorkloadNum" not in n


def test_oversold_workload_is_not_a_quota_conflict(store, cfg):
    seed(store)
    store.save("workloads", [{"WorkloadId": "job", "WorkloadName": "job", "WorkloadStatus": "Running",
        "UserId": "person", "UserName": "Alice", "requested_gpu": 1, "oversold": True}], now=960)
    assert overview(store, cfg, 1000)["users"][0]["conflict"] is False


def test_read_only_store_cannot_write(store):
    ro = PaiStore(store.path, read_only=True)
    with pytest.raises(sqlite3.OperationalError):
        ro.save("bad", {})


def test_pai_disabled_registers_no_api_routes(monkeypatch):
    from gpumon.api import pai
    from gpumon.api.app import create_app
    monkeypatch.setattr(pai, "load_pai_settings", lambda: PaiSettings())
    client = TestClient(create_app())
    for path in ("/api/pai/status", "/api/pai/overview", "/api/pai/ranking", "/api/pai/metrics/series?workload_id=x"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "PAI" not in response.text and "enabled" not in response.text


def test_invalid_pai_config_keeps_api_off(monkeypatch):
    from gpumon.api import pai
    def broken():
        raise ValueError("Enabled PAI requires account_id, workspace_id and quota_id")
    monkeypatch.setattr(pai, "load_pai_settings", broken)
    assert pai.pai_enabled() is False


def test_pai_enabled_registers_routes(monkeypatch, cfg, tmp_path):
    from gpumon.api import pai
    from gpumon.api.app import create_app
    cfg.db_path = str(tmp_path / "missing.db")
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    client = TestClient(create_app())
    assert client.get("/api/pai/status").json() == {"enabled": True, "state": "waiting"}
    assert client.get("/api/pai/status").headers["cache-control"] == "no-store"


def test_response_contains_no_credentials_and_masks_names(store, cfg, monkeypatch):
    from gpumon.api import pai
    seed(store)
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai, "mask_username", lambda s: "A***e" if s else s)
    result = pai.snapshot()
    assert result["users"][0]["Username"] == "A***e"
    assert result["workloads"][0]["UserName"] == "A***e"
    assert "cli_path" not in json.dumps(result)
    assert "profile" not in json.dumps(result)


def test_read_only_transport_rejects_non_monitoring_operations(cfg):
    with pytest.raises(ValueError, match="Only monitoring"):
        PaiClient(cfg)._api("DeleteInstance", "/")


def test_json_throttle_stops_new_calls(cfg, monkeypatch):
    from types import SimpleNamespace
    from gpumon.pai import client as module
    calls = []
    def run(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=b'{"Success":false,"Code":"Throttling"}', stderr=b'')
    monkeypatch.setattr(module.subprocess, "run", run)
    client = PaiClient(cfg)
    for _ in range(2):
        with pytest.raises(CollectionError, match="rate_limited"):
            client.identity()
    assert len(calls) == 1


def test_job_detail_keeps_only_strategy_and_specs():
    j = job_row({"settings": {"oversold_type": "ForceQuotaOverSold", "enable_tide_resource": False,
                              "enable_error_monitoring_in_ai_master": False},
                 "elastic_spec": {"enable_ai_master": False}, "status": "Running",
                 "envs": {"SECRET": "x"}, "user_command": "python train.py --token x",
                 "job_specs": [{"type": "Worker", "pod_count": 12,
                                "resource_config": {"cpu": "192", "gpu": "8", "memory": "1600Gi"}}]})
    assert j["oversold_type"] == "ForceQuotaOverSold" and j["aimaster"] is False and j["tide"] is False
    assert j["specs"] == [{"type": "Worker", "pods": 12, "gpu": 8, "cpu": 192, "mem_gib": 1600, "gpu_type": None}]
    assert "SECRET" not in json.dumps(j) and "token" not in json.dumps(j)
    assert (mem_gib("524288Mi"), mem_gib("1Ti"), mem_gib(None), mem_gib("bad")) == (512, 1024, None, None)
    w = workload_row({"Resource": {"CPU": "96", "GPU": "8", "Memory": "524288Mi"}})
    assert (w["requested_cpu"], w["requested_mem_gib"]) == (96, 512)


def test_host_metrics_have_no_gpu_dimension(cfg):
    rows = normalize_metrics([{"jobId": "job", "pod": "p", "timestamp": 900, "Value": 12.5}], cfg, "job", "cpu", 960, per_gpu=False)
    assert rows[0][5] == "" and rows[0][2] == 12.5
    assert normalize_metrics([{"jobId": "job", "pod": "p", "timestamp": 900, "Value": 12.5}], cfg, "job", "compute", 960) == []


def test_usage_counts_only_observed_time_and_splits_hours(store):
    w = {"WorkloadId": "job", "UserId": "u", "UserName": "Alice", "QuotaId": "q", "WorkloadType": "dlc",
         "gpus": 8, "cpu": 96, "mem_gib": 512, "oversold": True, "dequeued_at": 3500}
    store.record_usage([w], 3660, max_gap=360)      # first sight: back to dequeue time, split across 0/3600
    store.record_usage([w], 3780, max_gap=360)      # normal 120 s round
    store.record_usage([w], 3780 + 7200, max_gap=360)  # collector down for 2 h: only 360 s count
    with store.connect() as c:
        rows = {r["hour"]: dict(r) for r in c.execute("SELECT * FROM usage_hour")}
    assert rows[0]["run_s"] == 100 and rows[3600]["run_s"] == 60 + 120
    assert sum(r["run_s"] for r in rows.values()) == 100 + 60 + 120 + 360
    assert rows[0]["gpu_s"] == 800 and rows[0]["oversold_gpu_s"] == 800 and rows[0]["mem_gib_s"] == 512 * 100
    store.put_metrics(normalize_metrics([{"jobId": "job", "pod": "p", "gpu": str(i), "timestamp": 3600 + 60 * i, "Value": 50}
                                         for i in range(2)], PaiSettings(enabled=True, metric_window_s=1800), "job", "compute", 3780), 0)
    store.refresh_utilization(3780)
    data = store.ranking(3780 + 60, 3600)
    row = data["rows"][0]
    assert row["compute_n"] == 2 and row["compute_sum"] == 100
    assert row["effective_gpu_s"] == 2 * 60 * 0.5
    assert row["measured_gpu_s"] == 2 * 60  # Two samples cannot cover all 8 GPUs for 180 seconds.


def test_ranking_api_aggregates_users(store, cfg, monkeypatch):
    from gpumon.api import pai
    cfg.db_path = str(store.path)
    store.save("quotas", [{"quota_id": "q", "quota_name": "research"}])
    now = 10 * 3600
    store.record_usage([{"WorkloadId": "a", "UserId": "u", "UserName": "Alice", "QuotaId": "q", "WorkloadType": "dsw",
                         "gpus": 2, "cpu": 4, "mem_gib": 8, "dequeued_at": now - 120}], now, 360)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai, "mask_username", lambda s: s)
    monkeypatch.setattr(pai.time, "time", lambda: now + 10)
    result = pai.pai_ranking(Response(), "24h")
    u = result["users"][0]
    assert (u["username"], round(u["gpu_hours"], 4), round(u["cpu_core_hours"], 4)) == ("Alice", round(240 / 3600, 4), round(480 / 3600, 4))
    assert u["quotas"][0]["quota_name"] == "research" and u["compute_mean"] is None


def test_cached_job_detail_is_not_stale_within_its_refresh(store, cfg):
    seed(store)
    store.save("job:job", {"oversold_type": "AcceptQuotaOverSold", "specs": []}, now=960)
    store.save("round", {"ok": True, "active_sources": ["identity", "nodes", "workloads", "users", "pods:node",
                                                         "metric:job:compute", "job:job", "round"]}, now=2000)
    for name in ("identity", "nodes", "workloads", "users", "pods:node", "metric:job:compute"):
        with store.connect() as c:
            c.execute("UPDATE source SET fetched_at=1990 WHERE name=?", (name,))
    d = overview(store, cfg, 2000)
    assert {s["name"]: s["state"] for s in d["sources"]}["job:job"] == "ok"
    assert d["workloads"][0]["job"]["oversold_type"] == "AcceptQuotaOverSold"


def test_recent_mean_smooths_low_utilization(store, cfg):
    seed(store)
    points = [{"jobId": "job", "pod": "pod", "gpu": "0", "timestamp": 960 - 60 * i, "Value": v}
              for i, v in enumerate([0, 100, 100, 100, 100])]
    store.put_metrics(normalize_metrics(points, PaiSettings(enabled=True, metric_window_s=1800), "job", "compute", 960), 0)
    d = overview(store, cfg, 1000)
    m = [x for x in d["workloads"][0]["metrics"] if x["metric"] == "compute"][0]
    assert (m["value"], m["recent_mean"], m["recent_n"]) == (0, 80, 5)
    assert d["nodes"][0]["cards"][0]["compute"]["recent"] == 80


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_cli_throttle_on_either_stream_stops_new_calls(cfg, monkeypatch, stream):
    from types import SimpleNamespace
    from gpumon.pai import client as module
    calls = []
    def run(*args, **kwargs):
        calls.append(args)
        output = {"stdout": b"", "stderr": b"", stream: b"Throttling: secret-signed-url"}
        return SimpleNamespace(returncode=1, **output)
    monkeypatch.setattr(module.subprocess, "run", run)
    client = PaiClient(cfg)
    for _ in range(2):
        with pytest.raises(CollectionError, match="^rate_limited$"):
            client.identity()
    assert len(calls) == 1


@pytest.mark.parametrize("disabled,enabled", [("maybe", None), (None, None), ("false", True), ("true", False)])
def test_unknown_oversold_switch_stays_unknown(disabled, enabled):
    assert quota_row({"quota_config": {"oversold_usage_config": {"disabled": disabled}}})["oversold_enabled"] is enabled


def test_abandoned_partial_round_becomes_stale(store, cfg):
    seed(store)
    store.save("round", {"ok": False}, state="partial", now=960)
    assert overview(store, cfg, 1000)["state"] == "partial"
    assert overview(store, cfg, 2000)["state"] == "stale"


@pytest.mark.parametrize("failed,status,expected_seconds", [(True, "Running", 0), (False, "Pending", 0), (False, "Running", 120)])
def test_usage_requires_fresh_running_snapshot(store, cfg, monkeypatch, failed, status, expected_seconds):
    from gpumon.pai import collector
    import threading
    raw = {"WorkloadId": "job", "WorkloadType": "dsw", "WorkspaceId": cfg.workspace_id,
           "UserId": "u", "WorkloadStatus": status, "IsScheduled": True,
           "Resource": {"GPU": "8"}, "ScheduledResource": {"GPU": "0"}}
    row = workload_row(raw)
    row["dequeued_at"] = 880
    store.save("workloads", [row], now=900)
    monkeypatch.setattr(collector.time, "time", lambda: 1000)
    class Client:
        calls = 0
        lock = threading.Lock()
        def identity(self): return {"AccountId": cfg.account_id}
        def quota(self, qid): return {"quota_id": qid}
        def nodes(self, qid): return [], 0
        def users(self): return [], 0
        def members(self): return [], 0
        def quota_roles(self): return [], 0
        def metrics(self, *args): return []
        def workloads(self):
            if failed: raise CollectionError("timeout")
            return [{**raw, "GmtDequeuedTime": "1970-01-01T00:14:40Z"}], 1
    collector.run_once(cfg, store, Client())
    with store.connect() as c:
        usage = c.execute("SELECT COALESCE(SUM(run_s),0), COALESCE(SUM(gpu_s),0) FROM usage_hour").fetchone()
    assert tuple(usage) == (expected_seconds, 0)  # A known zero scheduled GPU count must stay zero.


def test_collector_snapshot_is_group_readable_but_not_world_readable(tmp_path, cfg, monkeypatch):
    import os
    from gpumon.pai import collector
    cfg.db_path = str(tmp_path / "data/pai.db")
    monkeypatch.setattr(collector, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(collector, "run_once", lambda *a: {"ok": True, "errors": {}})
    original = os.umask(0o077)
    try:
        assert collector.main(["--once"]) == 0
        assert (tmp_path / "data").stat().st_mode & 0o777 == 0o750
        assert (tmp_path / "data/pai.db").stat().st_mode & 0o777 == 0o640
    finally:
        os.umask(original)


def test_quota_history_time_weighted_capacity_gaps_failure_and_unknown(store):
    def q(cap, used):
        return [{"quota_id": "f", "quota_name": "Feature", "gpu_capacity": cap, "gpu_used": used}]
    store.record_quota_usage(q(8, 4), 3500, 360)
    assert store.quota_ranking(0, 7200) == []  # no invented history before first observation
    store.record_quota_usage(q(16, 4), 3660, 360)
    store.record_quota_usage(q(16, 8), 3780, 360)
    rows = store.quota_ranking(0, 7200)
    assert rows[0]["observed_s"] == 280
    assert rows[0]["capacity_gpu_s"] == 8 * 160 + 16 * 120
    assert rows[0]["used_gpu_s"] == 4 * 280
    store.record_quota_usage(q(16, 8), 7380, 360)  # bounded outage, not a full hour
    assert store.quota_ranking(0, 10000)[0]["observed_s"] == 640
    store.record_quota_usage([], 7500, 360)  # failed source breaks continuity
    store.record_quota_usage(q(16, 8), 7620, 360)
    assert store.quota_ranking(0, 10000)[0]["observed_s"] == 640
    store.record_quota_usage(q(None, 0), 7740, 360)  # unknown != zero
    store.record_quota_usage(q(16, 0), 7860, 360)
    assert store.quota_ranking(0, 10000)[0]["observed_s"] == 640
    store.record_quota_usage(q(16, 0), 7860, 360)  # retry idempotency
    assert store.quota_ranking(0, 10000)[0]["observed_s"] == 640


def test_feature_ranking_attribution_oversold_zero_quota_and_deleted_quota(store, cfg, monkeypatch):
    from gpumon.api import pai
    now = 10 * 3600
    cfg.db_path = str(store.path)
    quotas = [{"quota_id": "q", "quota_name": "feature", "gpu_capacity": 8, "gpu_used": 4},
              {"quota_id": cfg.quota_id, "quota_name": "root", "gpu_capacity": 16, "gpu_used": 8},
              {"quota_id": "zero", "quota_name": "zero", "gpu_capacity": 0, "gpu_used": 0}]
    store.save("quotas", quotas, now=now)
    store.record_quota_usage(quotas, now - 120, 360)
    store.record_quota_usage(quotas, now, 360)
    workloads = [{"WorkloadId": wid, "UserId": uid, "UserName": uid, "QuotaId": qid,
                  "gpus": 2, "oversold": idle, "dequeued_at": now - 120}
                 for wid, uid, qid, idle in [("a", "u1", "q", False), ("b", "u2", "q", True),
                                           ("c", "u1", cfg.quota_id, False), ("d", "u3", "deleted", False)]]
    store.record_usage(workloads, now, 360)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai, "mask_username", lambda s: s)
    monkeypatch.setattr(pai.time, "time", lambda: now)
    data = pai.pai_ranking(Response(), "24h")
    fs = {r["quota_id"]: r for r in data["features"]}
    assert fs["q"]["gpu_hours"] == 480 / 3600
    assert fs["q"]["quota_gpu_hours"] == fs["q"]["oversold_gpu_hours"] == 240 / 3600
    assert fs["q"]["workloads"] == 2 and fs["q"]["occupancy_pct"] == 50
    assert fs["q"]["compute_mean"] is None and fs["q"]["measured_gpu_hours"] == 0
    assert cfg.quota_id not in fs
    assert data["root_quota"]["gpu_hours"] == 240 / 3600  # direct submissions only
    assert data["root_quota"]["is_root"] and data["root_quota"]["rank"] is None
    assert fs["zero"]["gpu_hours"] == 0 and fs["zero"]["occupancy_pct"] is None
    assert fs["deleted"]["current_capacity_gpu"] is None
    assert fs["deleted"]["occupancy_pct"] is None
    assert fs["q"]["quota_coverage_pct"] < 1
    store.failure("quotas", "test", now=now)
    assert pai.pai_ranking(Response(), "24h")["quota_fresh"] is False


def test_reporting_weeks_use_china_monday_and_exclude_next_week(store, cfg, monkeypatch):
    from datetime import datetime, timezone
    from gpumon.api import pai
    # Monday 2026-10-12 00:00:00 China = Sunday 16:00 UTC
    monday = datetime(2026, 10, 11, 16, tzinfo=timezone.utc).timestamp()
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai, "mask_username", lambda s: s)
    monkeypatch.setattr(pai.time, "time", lambda: monday + 3600)
    store.record_usage([{"WorkloadId": "past", "UserId": "u", "gpus": 2, "dequeued_at": monday - 120}], monday, 360)
    store.record_usage([{"WorkloadId": "next", "UserId": "u", "gpus": 8, "dequeued_at": monday}], monday + 120, 360)
    last = pai.pai_ranking(Response(), "last_week")
    assert (last["since"], last["until"]) == (monday - 7 * 86400, monday)
    assert last["users"][0]["gpu_hours"] == 240 / 3600
    current = pai.pai_ranking(Response(), "week")
    assert current["since"] == monday and current["users"][0]["gpu_hours"] == 960 / 3600


def test_quota_history_read_before_additive_migration(store):
    with store.connect() as c:
        c.execute("DROP TABLE quota_hour")
    assert store.quota_ranking(0, 100) == []


def test_ranking_http_default_week_and_no_history_is_unknown(store, cfg, monkeypatch):
    from gpumon.api import pai
    from gpumon.api.app import create_app
    cfg.db_path = str(store.path)
    store.save("quotas", [{"quota_id": "feature", "quota_name": "Feature", "gpu_capacity": 8, "gpu_used": 0}])
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    client = TestClient(create_app())
    response = client.get("/api/pai/ranking")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data["window"] == "week" and data["timezone"] == "Asia/Shanghai"
    feature = data["features"][0]
    assert feature["gpu_hours"] is None and feature["workloads"] is None
    assert feature["occupancy_pct"] is None and feature["current_occupancy_pct"] == 0
    assert client.get("/api/pai/ranking?window=invalid").status_code == 400


@pytest.mark.parametrize('field,value', [
    ('ranking_timezone', 'Invalid/Nowhere'), ('ranking_timezone', '../UTC'),
    ('ranking_week_start', 'Monday'), ('ranking_week_start', 'noday'),
    ('ranking_reset_time', '24:00'), ('ranking_reset_time', '09:60'), ('ranking_reset_time', '9:00'),
])
def test_invalid_reporting_config_is_rejected(field, value):
    with pytest.raises(ValueError):
        PaiSettings(**{field: value})


@pytest.mark.parametrize('zone,day,reset,now,start,end', [
    ('Asia/Shanghai', 'monday', '00:00', '2027-01-01T12:00:00+00:00', '2026-12-27T16:00:00+00:00', None),
    ('Asia/Kolkata', 'friday', '08:45', '2026-10-09T04:00:00+00:00', '2026-10-09T03:15:00+00:00', None),
    ('UTC', 'sunday', '18:00', '2026-10-11T17:59:59+00:00', '2026-10-04T18:00:00+00:00', None),
    ('UTC', 'sunday', '18:00', '2026-10-11T18:00:00+00:00', '2026-10-11T18:00:00+00:00', None),
    # Previous weeks across DST are 167 and 169 hours, not always 168.
    ('Europe/Berlin', 'monday', '00:00', '2026-03-30T12:00:00+00:00', '2026-03-22T23:00:00+00:00', '2026-03-29T22:00:00+00:00'),
    ('Europe/Berlin', 'monday', '00:00', '2026-10-26T12:00:00+00:00', '2026-10-18T22:00:00+00:00', '2026-10-25T23:00:00+00:00'),
    # Missing 02:30 is shifted forward; repeated 02:30 uses its first occurrence.
    ('Europe/Berlin', 'sunday', '02:30', '2026-03-29T01:30:00+00:00', '2026-03-29T01:30:00+00:00', None),
    ('Europe/Berlin', 'sunday', '02:30', '2026-10-25T01:15:00+00:00', '2026-10-25T00:30:00+00:00', None),
])
def test_configurable_reporting_boundaries(zone, day, reset, now, start, end):
    from datetime import datetime
    from gpumon.pai.reporting import reporting_period
    stamp = lambda s: datetime.fromisoformat(s).timestamp()
    cfg = PaiSettings(ranking_timezone=zone, ranking_week_start=day, ranking_reset_time=reset)
    assert reporting_period(stamp(now), cfg, previous=end is not None) == (stamp(start), stamp(end or now))


def test_fractional_boundary_buckets_preserve_additive_usage_and_denominators(store):
    with store.connect() as c:
        c.execute("INSERT INTO usage_hour(hour,workload_id,user_id,quota_id,gpu_s,compute_sum,compute_n) VALUES (0,'a','a','q',28800,50,1)")
        c.execute("INSERT INTO usage_hour(hour,workload_id,user_id,quota_id,gpu_s,compute_sum,compute_n) VALUES (3600,'b','b','q',14400,100,1)")
        c.execute("INSERT INTO quota_hour VALUES (0,'q','q',3600,28800,7200)")
        c.execute("INSERT INTO quota_hour VALUES (3600,'q','q',3600,57600,28800)")
    r = store.ranking(5400, 3600, since=1800, observed_until=7200)['rows']
    assert {x['user_id']: x['gpu_s'] / 3600 for x in r} == {'a': 4, 'b': 2}
    assert sum(x['effective_gpu_s'] for x in r) == 45
    assert sum(x['measured_gpu_s'] for x in r) == 60
    q = store.quota_ranking(1800, 5400, observed_until=7200)[0]
    assert (q['observed_s'], q['capacity_gpu_s'] / 3600, q['used_gpu_s'] / 3600) == (3600, 12, 5)
    pieces = [(0, 1800), (1800, 5400), (5400, 7200)]
    assert sum(sum(r['gpu_s'] for r in store.ranking(end, end-start, since=start, observed_until=7200)['rows']) for start, end in pieces) == 43200
    assert sum(store.quota_ranking(start, end, observed_until=7200)[0]['observed_s'] for start, end in pieces) == 7200


def test_ongoing_hour_is_not_discounted_again(store):
    with store.connect() as c:
        c.execute("INSERT INTO usage_hour(hour,workload_id,user_id,quota_id,gpu_s) VALUES (3600,'a','a','q',7200)")
    assert store.ranking(5400, 1800, since=3600)['rows'][0]['gpu_s'] == 7200
    assert store.ranking(5400, 900, since=4500)['rows'][0]['gpu_s'] == 3600
    with store.connect() as c:
        c.execute("UPDATE usage_hour SET gpu_s=0.5")
    assert store.ranking(3600.5, 0.5, since=3600)['rows'][0]['gpu_s'] == 0.5


def test_http_reporting_config_controls_window_and_metadata(store, cfg, monkeypatch):
    from datetime import datetime
    from gpumon.api import pai
    from gpumon.api.app import create_app
    cfg.db_path = str(store.path)
    cfg.ranking_timezone, cfg.ranking_week_start, cfg.ranking_reset_time = 'Asia/Kolkata', 'friday', '08:45'
    monkeypatch.setattr(pai, 'load_pai_settings', lambda: cfg)
    monkeypatch.setattr(pai.time, 'time', lambda: datetime.fromisoformat('2026-10-09T04:00:00+00:00').timestamp())
    data = TestClient(create_app()).get('/api/pai/ranking').json()
    assert data['since'] == datetime.fromisoformat('2026-10-09T03:15:00+00:00').timestamp()
    assert (data['timezone'], data['week_start'], data['reset_time'], data['boundary_estimate']) == ('Asia/Kolkata', 'friday', '08:45', True)


def test_borrowing_stays_in_owned_capacity_and_hidden_cards_are_unknown(store, cfg):
    seed(store)
    store.save('nodes', [{'NodeName': 'node', 'GPU': '4', 'RequestGPU': 1}], now=960)
    ws=store.sources()['workloads']['payload']
    ws.append({'WorkloadId':'borrowed','WorkloadName':'borrowed','WorkloadStatus':'Running',
               'UserId':'b','scheduled_gpu':2,'requested_gpu':2,'oversold':True})
    store.save('workloads', ws, now=960)
    for wid, values in [('job',[100]),('borrowed',[50,50])]:
        store.save(f'metric:{wid}:compute',[{'sampled_at':900}],now=960)
        store.put_metrics(normalize_metrics([{'jobId':wid,'pod':'pod','gpu':str(i),'timestamp':900,'Value':v}
                                            for i,v in enumerate(values)],cfg,wid,'compute',960),0)
    d=overview(store,cfg,1000); s=d['summary']
    assert s['physical_gpus']==4 and s['pool_scheduled_gpus']==3
    assert s['pool_compute_estimate']==50  # (100+50+50)/4, not /6 and not /3.
    assert s['cluster_compute_mean'] is None and s['cluster_unallocated_gpus']==0
    assert s['cluster_known_gpus']==1 and d['nodes'][0]['free_known'] is False
    assert d['nodes'][0]['possibly_borrowed'] is True
    assert d['nodes'][0]['cards'][1]['compute'] is None  # Display zero is not telemetry.
    store.failure('metric:borrowed:compute','unavailable',now=990)
    assert overview(store,cfg,1000)['summary']['pool_compute_estimate'] is None


@pytest.mark.parametrize('problem', ['pods_failed', 'nodes_stale', 'workloads_failed', 'request_mismatch', 'regular_unmapped'])
def test_borrowing_display_does_not_hide_mapping_failures(store, cfg, problem):
    seed(store)
    workloads = store.sources()['workloads']['payload']
    workloads.append({'WorkloadId': 'borrowed', 'WorkloadStatus': 'Running',
                      'UserId': 'b', 'scheduled_gpu': 1, 'requested_gpu': 1,
                      'oversold': problem != 'regular_unmapped'})
    store.save('workloads', workloads, now=960)
    if problem == 'pods_failed':
        store.failure('pods:node', 'unavailable', now=990)
    elif problem == 'nodes_stale':
        store.save('nodes', store.sources()['nodes']['payload'], now=1)
    elif problem == 'workloads_failed':
        store.failure('workloads', 'unavailable', now=990)
    elif problem == 'request_mismatch':
        store.save('nodes', [{'NodeName': 'node', 'GPU': '4', 'RequestGPU': 2}], now=960)
    node = overview(store, cfg, 1000)['nodes'][0]
    assert node['possibly_borrowed'] is False
    assert node['free_known'] is False


def test_cluster_history_preserves_coverage_capacity_changes_and_gaps(store):
    def sample(cap, known, task):
        return dict(cluster_snapshot_fresh=True,physical_gpus=cap,cluster_known_gpus=known,
                    cluster_effective_gpus=1,pool_scheduled_gpus=3,pool_task_effective_gpus=task)
    store.record_cluster_usage(sample(4,1,2),3500,360)
    assert store.cluster_ranking(0,4000)['observed_hours']==0
    store.record_cluster_usage(sample(8,8,None),3660,360)
    store.record_cluster_usage(sample(8,8,None),3780,360)
    r=store.cluster_ranking(0,4000)
    assert r['observed_hours']==280/3600
    assert r['capacity_gpu_hours']==(4*160+8*120)/3600
    assert r['task_utilization_estimate_pct']==50 and r['task_occupancy_pct']==75
    assert r['task_estimate_hours']==160/3600
    assert r['task_estimate_coverage_pct']==4
    assert r['physical_utilization_pct'] is None
    store.record_cluster_usage(sample(8,8,2),7380,360)
    assert store.cluster_ranking(0,8000)['observed_hours']==640/3600
    store.record_cluster_usage({},7500,360)
    store.record_cluster_usage(sample(8,8,2),7620,360)
    assert store.cluster_ranking(0,8000)['observed_hours']==640/3600
    store.record_cluster_usage(sample(8,8,2),7620,360)
    assert store.cluster_ranking(0,8000)['observed_hours']==640/3600


def test_efficiency_uses_measured_gpu_time_not_full_missing_hour(store,cfg,monkeypatch):
    from gpumon.api import pai
    cfg.db_path=str(store.path)
    with store.connect() as c:
        c.execute("INSERT INTO usage_hour(hour,workload_id,user_id,quota_id,gpu_s,oversold_gpu_s,compute_sum,compute_n) VALUES (0,'a','u','q',3600,3600,50,1)")
        c.execute("INSERT INTO usage_hour(hour,workload_id,user_id,quota_id,gpu_s,compute_sum,compute_n) VALUES (0,'b','u','q',3600,6000,60)")
    monkeypatch.setattr(pai,'load_pai_settings',lambda:cfg)
    monkeypatch.setattr(pai.time,'time',lambda:3600)
    d=pai.pai_ranking(Response(),'24h')
    for row in [d['users'][0],d['features'][0]]:
        assert row['gpu_hours']==2 and row['borrowed_gpu_hours']==1
        assert row['measured_gpu_hours']==pytest.approx(61/60)
        assert row['effective_gpu_hours']==pytest.approx(1+0.5/60)
        assert row['gpu_metric_coverage_pct']==pytest.approx(61/120*100)
        assert row['hardware_efficiency_pct']==pytest.approx(60.5/61*100)
    with store.connect() as c:
        c.execute('DROP TABLE cluster_hour')
    assert store.cluster_ranking(0,3600)['task_utilization_estimate_pct'] is None


def test_paused_borrowing_and_failed_snapshots_do_not_accrue_gpu_time(store):
    w={'WorkloadId':'b','WorkloadStatus':'Running','gpus':4,'dequeued_at':900,'oversold':True}
    store.record_usage([w],1000,360,workload_snapshot=[w])
    store.record_usage([],1120,360,workload_snapshot=[{**w,'WorkloadStatus':'Pending','scheduled':False}])
    store.record_usage([],1240,360,workload_snapshot=[{**w,'WorkloadStatus':'Pending','scheduled':False}])
    store.record_usage([w],1360,360,workload_snapshot=[w])  # No new dequeue timestamp: do not invent resume time.
    assert sum(r['gpu_s'] for r in store.ranking(1361,3600)['rows'])==400
    store.record_usage([w],1480,360,workload_snapshot=[w])
    store.record_usage([],1600,360,workload_snapshot=False)
    store.record_usage([w],1720,360,workload_snapshot=[w])
    assert sum(r['gpu_s'] for r in store.ranking(1721,3600)['rows'])==880
    store.record_usage([],1840,360,workload_snapshot=[{**w,'WorkloadStatus':'Pending'}])
    resumed={**w,'dequeued_at':1900}
    store.record_usage([resumed],1960,360,workload_snapshot=[resumed])
    assert sum(r['gpu_s'] for r in store.ranking(1961,3600)['rows'])==1120


def test_current_pool_counts_borrowed_once_and_keeps_quota_counters_separate(store, cfg, monkeypatch):
    from gpumon.api import pai
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai.time, "time", lambda: 3600)
    store.save("nodes", [{"GPU": 8}], now=3600)
    store.save("workloads", [
        {"WorkloadStatus": "Running", "scheduled_gpu": 4, "requested_gpu": 8},
        {"WorkloadStatus": "Running", "scheduled_gpu": 2, "oversold": True},
        {"WorkloadStatus": "Pending", "requested_gpu": 8, "oversold": True}], now=3600)
    store.save("quotas", [{"quota_id": "f", "gpu_capacity": 8, "gpu_used": 4, "ancestors_allocated_gpu": 1}], now=3600)
    d = pai.pai_ranking(Response(), "week")
    p = d["current_pool"]
    assert (p["capacity_gpu"], p["occupied_gpu"], p["borrowed_gpu"], p["occupancy_pct"]) == (8, 6, 2, 75)
    assert p["fresh"]
    assert d["features"][0]["current_ancestor_allocated_gpu"] == 1
    assert d["features"][0]["current_used_gpu"] == 4
    store.failure("workloads", "test", now=3600)
    assert pai.pai_ranking(Response(), "week")["current_pool"]["fresh"] is False


def test_feature_memberships_use_ids_and_explicit_custom_roles():
    from gpumon.pai.attribution import feature_memberships
    members = [{"UserId": "u", "Roles": ["PAI.WorkspaceAdmin", "role-a", "role-root"]},
               {"UserId": "v", "Roles": ["role-a", "role-b"]},
               {"UserId": "w", "Roles": ["PAI.WorkspaceAdmin", "role-root"]}]
    entries = [{"Type": "Quota", "Key": q, "Value": roles} for q, roles in
               [("root", "role-root"), ("a", "role-a,PAI.WorkspaceAdmin"), ("b", "role-b"), ("outside", "role-a")]]
    configs = [{"ConfigKey": "allowedRoles", "ConfigValue": json.dumps(entries)}]
    quotas = [{"quota_id": q} for q in ("root", "a", "b", "unrestricted")]
    assert feature_memberships(members, configs, quotas, "root") == [
        {"user_id": "u", "quota_ids": ["a"]}, {"user_id": "v", "quota_ids": ["a", "b"]},
        {"user_id": "w", "quota_ids": []}]
    assert feature_memberships(members, [{**configs[0], "IsDeleted": True}], quotas, "root")[0]["quota_ids"] == []
    configs.append({"ConfigKey": "allowedRoles", "ConfigValue": json.dumps([{"Type": "Quota", "Key": "a", "Value": "role-other"}])})
    with pytest.raises(CollectionError, match="conflicting_role_config"):
        feature_memberships(members, configs, quotas, "root")


@pytest.mark.parametrize("value", ['{}', '[{"Type":"Unknown"}]', '[{"Type":"Quota","Key":"a","Value":[]}]'])
def test_feature_memberships_reject_unsupported_configs(value):
    from gpumon.pai.attribution import feature_memberships
    with pytest.raises(CollectionError, match="invalid_response"):
        feature_memberships([], [{"ConfigKey": "allowedRoles", "ConfigValue": value}], [], "root")


def test_workspace_role_transport_is_bounded_readonly(cfg):
    client = PaiClient(cfg)
    calls = []
    def call(args):
        calls.append(args)
        return {"Members": [], "Configs": [], "TotalCount": 0}
    client._call = call
    assert client.members() == ([], 0)
    assert client.quota_roles() == ([], 0)
    for args in calls:
        assert args[:2] == ["api", "aiworkspace"]
        assert args[args.index("--endpoint") + 1] == "aiworkspace.cn-hangzhou.aliyuncs.com"
        assert args[args.index("--method") + 1] == "GET"
        assert args[args.index("--version") + 1] == "2021-02-04"
    assert "CategoryName=CommonQuotaConfig" in calls[1]
    with pytest.raises(ValueError):
        client._api("CreateMember", "/")


@pytest.mark.parametrize("state,age", [("ok", 0), ("error", 0), ("ok", 601), ("missing", 0)])
def test_root_attribution_conserves_totals_and_metrics(store, cfg, monkeypatch, state, age):
    from gpumon.api import pai
    now = 36000
    cfg.db_path = str(store.path)
    store.save("quotas", [{"quota_id": cfg.quota_id, "quota_name": "training", "gpu_capacity": 8, "gpu_used": 6},
                           {"quota_id": "a", "quota_name": "A", "gpu_capacity": 4, "gpu_used": 2},
                           {"quota_id": "b", "quota_name": "B", "gpu_capacity": 4, "gpu_used": 0}], now=now)
    if state != "missing":
        store.save("feature_memberships", [{"user_id": "unique", "quota_ids": ["a"]},
                    {"user_id": "multi", "quota_ids": ["a", "b"]}, {"user_id": "none", "quota_ids": []}], now=now-age)
        if state == "error": store.failure("feature_memberships", "permission_denied", now=now)
    jobs = [{"WorkloadId": wid, "UserId": uid, "QuotaId": q, "gpus": 2, "cpu": 4,
             "mem_gib": 8, "dequeued_at": now-120, "oversold": borrowed}
            for wid, uid, q, borrowed in [("direct", "unique", "a", False),
                ("root", "unique", cfg.quota_id, True), ("multi", "multi", cfg.quota_id, False),
                ("none", "none", cfg.quota_id, False), ("other", "unique", "b", False)]]
    store.record_usage(jobs, now, 360)
    with store.connect() as c:
        c.execute("UPDATE usage_hour SET compute_sum=20,compute_n=1 WHERE workload_id='direct'")
        c.execute("UPDATE usage_hour SET compute_sum=160,compute_n=2 WHERE workload_id='root'")
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai.time, "time", lambda: now)
    d = pai.pai_ranking(Response(), "24h")
    f = {r["quota_id"]: r for r in d["features"]}
    root, total = d["root_quota"], d["totals"]
    fresh = state == "ok" and age == 0
    assert d["feature_attribution"]["fresh"] is fresh
    assert d["feature_attribution"]["historical_role_membership"] is False
    assert cfg.quota_id not in f and root["rank"] is None
    assert [r["rank"] for r in d["features"]] == [1, 2]
    assert total["gpu_hours"] == pytest.approx(1200/3600)
    assert root["gpu_hours"] == pytest.approx(720/3600)
    assert f["a"]["gpu_hours"] == pytest.approx((480 if fresh else 240)/3600)
    assert f["b"]["gpu_hours"] == pytest.approx(240/3600)  # actual child submission wins
    assert f["a"]["direct_gpu_hours"] == pytest.approx(240/3600)
    assert f["a"]["root_attributed_gpu_hours"] == pytest.approx((240 if fresh else 0)/3600)
    assert root["unattributed_gpu_hours"] == pytest.approx((480 if fresh else 720)/3600)
    assert sum(r["gpu_hours"] for r in f.values()) + root["unattributed_gpu_hours"] == pytest.approx(total["gpu_hours"])
    assert sum(u["gpu_hours"] for u in d["users"]) == pytest.approx(total["gpu_hours"])
    assert f["a"]["compute_mean"] == (60 if fresh else 20)
    assert f["a"]["hardware_efficiency_pct"] == pytest.approx(60 if fresh else 20)
    assert f["a"]["borrowed_gpu_hours"] == pytest.approx((240 if fresh else 0)/3600)
    assert total["borrowed_gpu_hours"] == pytest.approx(240/3600)
    assert f["a"]["current_used_gpu"] == 2  # attribution never changes platform counters
    if fresh:
        assert d["feature_attribution"]["unresolved_root_gpu_hours"] == {"multiple_features": 240/3600, "no_feature_role": 240/3600}
        # Historical windows intentionally follow the *current* mapping, without rewriting usage.
        store.save("feature_memberships", [{"user_id": "unique", "quota_ids": ["b"]}], now=now)
        changed = pai.pai_ranking(Response(), "24h")
        ff = {r["quota_id"]: r for r in changed["features"]}
        assert ff["a"]["gpu_hours"] == pytest.approx(240/3600)
        assert ff["b"]["gpu_hours"] == pytest.approx(480/3600)
        assert changed["totals"] == total


def test_membership_failure_retains_snapshot_but_usage_collection_continues(store, cfg, monkeypatch):
    import threading
    from gpumon.pai import collector
    from gpumon.pai.attribution import membership_status
    now = 1000
    old = [{"user_id": "u", "quota_ids": ["child"]}]
    store.save("feature_memberships", old, now=0)
    monkeypatch.setattr(collector.time, "time", lambda: now)
    class Client:
        calls = 0
        lock = threading.Lock()
        def identity(self): return {"AccountId": cfg.account_id}
        def quota(self, q): return {"quota_id": q}
        def nodes(self, q): return [], 0
        def users(self): return [], 0
        def members(self): return [{"UserId": "u", "Roles": ["role-new"]}], 1
        def quota_roles(self): raise CollectionError("permission_denied")
        def metrics(self, *args): return []
        def workloads(self):
            return [{"WorkloadId": "job", "WorkloadType": "dsw", "WorkspaceId": cfg.workspace_id,
                     "UserId": "u", "QuotaId": cfg.quota_id, "WorkloadStatus": "Running", "IsScheduled": True,
                     "Resource": {"GPU": "2"}, "ScheduledResource": {"GPU": "2"},
                     "GmtDequeuedTime": "1970-01-01T00:14:40Z"}], 1
    result = collector.run_once(cfg, store, Client())
    assert result["errors"]["feature_memberships"] == "permission_denied"
    source = store.sources()["feature_memberships"]
    assert source["payload"] == old and source["fetched_at"] == 0
    mapping, status = membership_status(store.sources(), cfg, now)
    assert mapping == {} and status["state"] == "error"
    assert store.ranking(now, 3600)["rows"][0]["gpu_s"] == 240


@pytest.mark.parametrize("age,error,expected", [(40, False, "ok"), (601, False, "stale"), (40, True, "error")])
def test_membership_health_matches_attribution_in_status_api(store, cfg, monkeypatch, age, error, expected):
    from gpumon.api import pai
    now = 1000
    cfg.db_path = str(store.path)
    seed(store)
    store.save("feature_memberships", [{"user_id": "person", "quota_ids": ["child"]}], now=now-age)
    if error:
        store.failure("feature_memberships", "permission_denied", now=now)
    store.save("round", {"ok": True, "active_sources": list(store.sources())}, now=now)
    monkeypatch.setattr(pai, "load_pai_settings", lambda: cfg)
    monkeypatch.setattr(pai.time, "time", lambda: now)
    status = pai.pai_status(Response())
    source = next(s for s in status["sources"] if s["name"] == "feature_memberships")
    attribution = pai.pai_ranking(Response(), "24h")["feature_attribution"]
    assert source["state"] == attribution["state"] == expected
    assert attribution["fresh"] is (expected == "ok")
    assert status["state"] == ("ok" if expected == "ok" else "partial")


@pytest.mark.parametrize("method", ["latest_metrics", "recent_means"])
def test_snapshot_metric_queries_ignore_large_expired_history(store, monkeypatch, method):
    from contextlib import contextmanager
    now = 100000
    with store.connect() as c:
        c.executemany("INSERT INTO metric VALUES (?,?,?,?,?,?,?,?)", [
            (f"series-{i}", ts, 99, "old", "pod", str(i), "compute", ts)
            for i in range(100) for ts in range(300)])
        c.executemany("INSERT INTO metric VALUES (?,?,?,?,?,?,?,?)", [
            (f"live-{i}", now-offset, value, "live", "pod", str(i), "compute", now)
            for i in range(10) for offset,value in [(60,20),(120,40)]])
    original = store.connect
    instructions = [0]
    @contextmanager
    def bounded():
        with original() as c:
            def budget():
                instructions[0] += 100
                return int(instructions[0] > 20000)
            c.set_progress_handler(budget,100)
            yield c
    monkeypatch.setattr(store,"connect",bounded)
    result = getattr(store,method)(now)
    assert len(result) == 10
    if method == "latest_metrics":
        assert all(r["ts"] == now-60 and r["value"] == 20 for r in result)
    else:
        assert all(v == (30,2) for v in result.values())
    assert instructions[0] < 20000  # Retained rows must not consume the live-query budget.


def test_quota_presence_excludes_only_successful_absence_and_bounds_outages(store):
    def q(qid, cap=8):
        return {'quota_id': qid, 'quota_name': qid, 'gpu_capacity': cap, 'gpu_used': 0}
    # Complete snapshots establish presence even if the numeric counters are unknown.
    store.record_quota_usage([q('root'), q('f', None)], 0, 120, snapshot_complete=True)
    store.record_quota_usage([q('root')], 120, 120, snapshot_complete=True)
    store.record_quota_usage([q('root')], 240, 120, snapshot_complete=True)
    coverage = store.quota_coverage(0, 240)
    assert coverage['known_s'] == 240
    assert coverage['present_s']['f'] == 120
    assert coverage['present_s']['root'] == 240
    assert not any(r['quota_id'] == 'f' for r in store.quota_ranking(0, 240))
    # Error clears continuity, rather than treating an empty fallback as absence.
    store.record_quota_usage([], 360, 120, snapshot_complete=False)
    store.record_quota_usage([q('root')], 480, 120, snapshot_complete=True)
    assert store.quota_coverage(0, 480)['known_s'] == 240
    store.record_quota_usage([q('root')], 1200, 120, snapshot_complete=True)
    assert store.quota_coverage(0, 1200)['known_s'] == 360
    store.record_quota_usage([q('root')], 1200, 120, snapshot_complete=True)
    assert store.quota_coverage(0, 1200)['known_s'] == 360
    # Retention applies to presence and manual exclusions, too.
    with store.connect() as c:
        c.execute("INSERT INTO quota_absence_override VALUES (0,'f',120,'confirmed deletion')")
    store.record_quota_usage([], 33 * 86400, 120, snapshot_complete=False)
    assert store.quota_coverage(0, 1200) == {'known_s': 0, 'present_s': {}, 'historical_absent_s': {}}


def test_quota_coverage_existing_missing_new_absent_and_legacy(store, cfg, monkeypatch):
    from gpumon.api import pai
    now = 86400
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, 'load_pai_settings', lambda: cfg)
    monkeypatch.setattr(pai.time, 'time', lambda: now)
    store.save('quotas', [{'quota_id': q, 'quota_name': q} for q in ('active', 'new', 'absent')], now=now)
    # Over the whole window, topology was complete for 23h; one hour is unknown.
    with store.connect() as c:
        for hour in range(0, 23 * 3600, 3600):
            c.execute('INSERT INTO quota_presence_hour VALUES (?,?,?)', (hour, '', 3600))
            c.execute('INSERT INTO quota_presence_hour VALUES (?,?,?)', (hour, 'active', 3600))
        # New quota existed for the final observed hour only; previous 22h were absent.
        c.execute("INSERT INTO quota_presence_hour VALUES (79200,'new',3600)")
        c.execute("INSERT INTO quota_hour VALUES (79200,'new','new',3600,28800,14400)")
        c.execute("INSERT INTO quota_hour VALUES (0,'active','active',3600,28800,14400)")
    data = pai.pai_ranking(Response(), '24h')
    fs = {f['quota_id']: f for f in data['features']}
    assert fs['new']['observed_quota_hours'] == 1
    assert fs['new']['absent_quota_hours'] == 22
    assert fs['new']['expected_quota_hours'] == 2
    assert fs['new']['quota_coverage_pct'] == 50
    assert fs['active']['expected_quota_hours'] == 24
    assert fs['active']['quota_coverage_pct'] == pytest.approx(100 / 24)
    assert fs['absent']['expected_quota_hours'] == 1
    assert fs['absent']['quota_coverage_pct'] == 0  # Unknown hour remains missing.
    with store.connect() as c:
        c.execute("INSERT INTO quota_presence_hour VALUES (82800,'',3600)")
    fs = {f['quota_id']: f for f in pai.pai_ranking(Response(), '24h')['features']}
    assert fs['absent']['quota_coverage_pct'] is None
    assert fs['new']['quota_coverage_pct'] == 100
    # Additive migrations: an older DB remains readable without presence tables.
    with store.connect() as c:
        c.execute('DROP TABLE quota_presence_hour')
        c.execute('DROP TABLE quota_absence_override')
    fs = {f['quota_id']: f for f in pai.pai_ranking(Response(), '24h')['features']}
    assert fs['new']['expected_quota_hours'] == 24
    assert fs['new']['quota_coverage_pct'] == pytest.approx(100 / 24)


def test_historical_absence_changes_denominator_only_and_respects_boundaries(store, cfg, monkeypatch):
    from gpumon.api import pai
    now = 86400
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, 'load_pai_settings', lambda: cfg)
    monkeypatch.setattr(pai.time, 'time', lambda: now)
    with store.connect() as c:
        c.execute("INSERT INTO quota_hour VALUES (0,'merged','Merged',3600,28800,14400)")
        c.execute("INSERT INTO quota_absence_override VALUES (3600,'merged',3600,'user confirmed deletion')")
    data = pai.pai_ranking(Response(), '24h')
    f = data['features'][0]
    assert f['observed_quota_hours'] == 1
    assert f['expected_quota_hours'] == 23 and f['absent_quota_hours'] == 1
    assert f['quota_coverage_pct'] == pytest.approx(100 / 23)
    assert f['capacity_gpu_hours'] == 8 and f['used_gpu_hours'] == 4 and f['occupancy_pct'] == 50
    assert store.quota_coverage(5400, 7200)['historical_absent_s']['merged'] == 1800


def test_multi_role_users_direct_submissions_are_not_ambiguous(store, cfg, monkeypatch):
    from gpumon.api import pai
    now = 36000
    cfg.db_path = str(store.path)
    monkeypatch.setattr(pai, 'load_pai_settings', lambda: cfg)
    monkeypatch.setattr(pai.time, 'time', lambda: now)
    store.save('quotas', [{'quota_id': q, 'quota_name': q} for q in (cfg.quota_id, 'a', 'b')], now=now)
    store.save('feature_memberships', [{'user_id': 'multi', 'quota_ids': ['a', 'b']}], now=now)
    store.record_usage([{'WorkloadId': q, 'UserId': 'multi', 'QuotaId': q, 'gpus': 1, 'dequeued_at': now-120}
                        for q in (cfg.quota_id, 'a', 'b')], now, 360)
    d = pai.pai_ranking(Response(), '24h')
    assert d['feature_attribution']['unresolved_root_gpu_hours'] == {'multiple_features': 120/3600}
    assert all(f['direct_gpu_hours'] == 120/3600 and f['root_attributed_gpu_hours'] == 0 for f in d['features'])
    assert d['totals']['gpu_hours'] == pytest.approx(360/3600)
    assert len(d['users']) == 1 and len(d['users'][0]['quotas']) == 3
