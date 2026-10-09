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
    assert d["summary"] == {"physical_gpus": 2, "mapped_gpus": 1, "measured_gpus": 1,
                            "metric_denominator": 2, "compute_mean": 42,
                            "task_compute_mean": 42, "task_measured_gpus": 1,
                            "cluster_compute_mean": 21, "cluster_known_gpus": 2,
                            "cluster_unallocated_gpus": 1}
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
    assert summary["cluster_compute_mean"] == 0  # Mapped idle GPU plus one unallocated card.
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
    assert row["effective_gpu_s"] == 8 * 180 * 0.5


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
    assert fs[cfg.quota_id]["gpu_hours"] == 240 / 3600  # no double-counted child tasks
    assert fs[cfg.quota_id]["is_root"]
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
