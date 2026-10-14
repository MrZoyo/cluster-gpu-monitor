from __future__ import annotations

import argparse
import fcntl
import json
import os
import sqlite3
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .client import CollectionError, PaiClient
from .config import load_pai_settings
from .store import PaiStore
from .values import number

METRICS = {"compute": "CARD_GPU_DUTY_CYCLE", "memory": "CARD_GPU_ACCELERATOR_MEMORY_UTIL"}
# Pod-level host utilization (percent of the pod's limit), stored with an empty GPU dimension.
HOST_METRICS = {"dlc": {"cpu": "POD_CPU_UTIL", "ram": "POD_MEMORY_UTIL"},
                "dsw": {"cpu": "INSTANCE_CPU_UTIL", "ram": "INSTANCE_MEMORY_UTIL"}}
TERMINAL = ("Stopped", "Deleted", "Failed", "Complete", "Succeeded")


def select(data, keys):
    return {key: data.get(key) for key in keys.split()}


def flag(value):
    """Cloud booleans arrive as bool or "true"/"false"; anything else stays unknown."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "false"):
        return value.lower() == "true"
    return None


def epoch(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def text(value, limit=300):
    return str(value)[:limit] if value not in (None, "") else None


def mem_gib(value):
    """Kubernetes-style quantity ("524288Mi", "1600Gi", "1Ti", bytes) to GiB."""
    if value in (None, ""):
        return None
    raw = str(value).strip()
    units = {"Ki": 1 / 1024 ** 2, "Mi": 1 / 1024, "Gi": 1, "Ti": 1024, "K": 1e3 / 1024 ** 3,
             "M": 1e6 / 1024 ** 3, "G": 1e9 / 1024 ** 3, "T": 1e12 / 1024 ** 3}
    for unit in sorted(units, key=len, reverse=True):
        if raw.endswith(unit):
            n = number(raw[:-len(unit)])
            return None if n is None else n * units[unit]
    n = number(raw)
    return None if n is None else n / 1024 ** 3


def workload_row(w):
    # UseOversoldResource marks workloads dequeued onto idle (oversold) capacity borrowed from other quotas in the owned pool.
    # Reason/Code come from the scheduler and explain why a queued workload is not placed.
    return {**select(w, "WorkloadId WorkloadName WorkloadType WorkloadStatus UserId UserName QuotaId WorkspaceId Status Phase"),
            "requested_gpu": number((w.get("Resource") or {}).get("GPU")),
            "requested_cpu": number((w.get("Resource") or {}).get("CPU")),
            "requested_mem_gib": mem_gib((w.get("Resource") or {}).get("Memory")),
            "scheduled_gpu": number((w.get("ScheduledResource") or {}).get("GPU")),
            "oversold": flag(w.get("UseOversoldResource")), "scheduled": flag(w.get("IsScheduled")),
            "queue_position": number(w.get("Position")), "priority": number(w.get("Priority")),
            "queue_reason": text(w.get("Reason")), "queue_code": text(w.get("Code") or w.get("CodeType"), 120),
            "enqueued_at": epoch(w.get("GmtEnqueuedTime")), "dequeued_at": epoch(w.get("GmtDequeuedTime"))}


def job_row(j):
    """Whitelisted DLC job detail: submission strategy, fault tolerance and per-role pod specs.
    Never keep envs, commands, code or data sources from the CLI response."""
    settings, elastic = j.get("settings") or {}, j.get("elastic_spec") or {}
    specs = []
    for spec in (j.get("job_specs") or [])[:16]:
        rc = spec.get("resource_config") or {}
        specs.append({"type": text(spec.get("type"), 40), "pods": number(spec.get("pod_count")),
                      "gpu": number(rc.get("gpu")), "cpu": number(rc.get("cpu")),
                      "mem_gib": mem_gib(rc.get("memory")), "gpu_type": text(rc.get("gpu_type"), 40)})
    return {"oversold_type": text(settings.get("oversold_type"), 40),
            "tide": flag(settings.get("enable_tide_resource")),
            "aimaster": flag(elastic.get("enable_ai_master")),
            "error_monitoring": flag(settings.get("enable_error_monitoring_in_ai_master")),
            "status": text(j.get("status"), 40), "sub_status": text(j.get("sub_status"), 60),
            "reason_code": text(j.get("reason_code"), 80), "specs": specs}


def quota_row(q):
    details = q.get("quota_details") or {}
    gpu = lambda key: number((details.get(key) or {}).get("gpu"))
    oversold = flag(((q.get("quota_config") or {}).get("oversold_usage_config") or {}).get("disabled"))
    # allocated = self + descendants + ancestors' workloads placed on this quota's resources.
    return {**select(q, "quota_id quota_name parent_quota_id gpu_capacity gpu_used status"),
            "allocated_gpu": gpu("allocated_quota"), "self_allocated_gpu": gpu("self_allocated_quota"),
            "descendants_allocated_gpu": gpu("descendants_allocated_quota"),
            "ancestors_allocated_gpu": gpu("ancestors_allocated_quota"),
            "oversold_enabled": None if oversold is None else not oversold}


def node_row(n):
    # Per-quota workload counters depend on the queried quota; keep only node-wide facts.
    return {**select(n, "NodeName NodeStatus GPU GPUType AllocatableGPU RequestGPU ResourceGroupId ReasonCode"),
            "ReasonMessage": str(n["ReasonMessage"])[:200] if n.get("ReasonMessage") else None,
            "health_rate": number(n.get("HealthRate")),
            "bound_quotas": [str(b.get("QuotaId")) for b in (n.get("BoundQuotas") or []) if b.get("QuotaId")]}


def normalize_metrics(points, cfg, workload, metric, now, per_gpu=True):
    rows = {}
    for point in points:
        # Never use the CMS account-level userId as a personal owner.
        required = ("gpu", "pod", "timestamp") if per_gpu else ("pod", "timestamp")
        if str(point.get("jobId")) != workload or not all(k in point for k in required):
            continue
        ts = point["timestamp"]
        if isinstance(ts, str) and "T" in ts:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        else:
            ts = float(ts)
            if ts > 1e11:
                ts /= 1000
        ts = int(ts)
        value = number(point.get("Value", point.get("Average", point.get("value"))))
        if value is None or value > 100 or ts > now + 60 or ts < now - cfg.metric_window_s:
            continue
        pod, gpu = str(point["pod"]), str(point["gpu"]) if per_gpu else ""
        sid = json.dumps([cfg.account_id, cfg.region, workload, pod, gpu, metric], separators=(",", ":"))
        rows[(sid, ts)] = (sid, ts, value, workload, pod, gpu, metric, now)
    return list(rows.values())


def run_once(cfg, store, client=None):
    client = client or PaiClient(cfg)
    started = time.time()
    previous = store.sources()
    errors, seen = {}, set()

    def fetch(name, function, normalize=lambda x: x, cache=False, min_interval=None, empty_ok=False):
        seen.add(name)
        old = previous.get(name, {})
        interval = cfg.topology_interval_s if cache else min_interval
        if interval and old.get("state") in ("ok", "no_data") and started - (old.get("fetched_at") or 0) < interval:
            return old["payload"]
        try:
            data = normalize(function())
            # An empty list is a real answer for pods ("no pods on this node"); for metrics it means no data.
            store.save(name, data, len(data) if isinstance(data, list) else None,
                       state="no_data" if data == [] and not empty_ok else "ok")
            return data
        except (CollectionError, ValueError, KeyError, TypeError) as exc:
            code = exc.code if isinstance(exc, CollectionError) else "invalid_response"
            store.failure(name, code)
            errors[name] = code
            return old.get("payload")

    identity = fetch("identity", client.identity,
                     lambda d: select(d, "AccountId UserId IdentityType"))
    if not identity or identity.get("AccountId") != cfg.account_id or "identity" in errors:
        store.failure("round", "identity_unverified")
        store.record_usage([], started, 2 * cfg.degraded_interval_s, workload_snapshot=False)
        store.record_quota_usage([], started, 2 * cfg.degraded_interval_s)
        store.record_cluster_usage({}, started, 2 * cfg.degraded_interval_s)
        return {"ok": False, "calls": client.calls,
                "errors": {"identity": errors.get("identity", "identity_unverified")}}

    def quotas():
        pending, visited, result = [cfg.quota_id], set(), []
        while pending:
            qid = pending.pop(0)
            if qid in visited:
                continue
            if len(visited) >= 32:
                raise CollectionError("quota_limit")
            visited.add(qid)
            q = client.quota(qid)
            pending.extend(s["quota_id"] for s in q.get("sub_quotas", []))
            result.append(quota_row(q))
        return result

    quota_rows = fetch("quotas", quotas, cache=True) or []
    def all_nodes():
        merged = {}
        with ThreadPoolExecutor(max_workers=cfg.concurrency) as executor:
            batches = list(executor.map(lambda q: client.nodes(q["quota_id"]), quota_rows))
        for rows, _ in batches:
            for n in rows:
                merged[n["NodeName"]] = node_row(n)
                if len(merged) > cfg.max_nodes:
                    raise CollectionError("node_limit")
        return list(merged.values())
    nodes = fetch("nodes", all_nodes, cache=True) or []
    workloads = fetch("workloads", client.workloads, lambda result: [workload_row(w) for w in result[0]]) or []
    fetch("users", client.users, lambda result: [{
        **select(u, "UserId Username WorkloadCount"),
        "used_gpu": number((u.get("Resources", {}).get("Used") or {}).get("GPU")),
        "submitted_gpu": number((u.get("Resources", {}).get("Submitted") or {}).get("GPU")),
    } for u in result[0]])

    def collect_pods(node):
        fetch("pods:" + node["NodeName"], lambda n=node: client.pods(n["NodeName"], n["ResourceGroupId"]),
              lambda result: [select(p, "PodName Phase WorkloadId WorkloadType WorkspaceId QuotaId GPUIndexes")
                              for p in result[0]], empty_ok=True)
    with ThreadPoolExecutor(max_workers=cfg.concurrency) as executor:
        list(executor.map(collect_pods, nodes))

    active = {w["WorkloadId"]: w for w in workloads
              if w["WorkloadType"] in ("dsw", "dlc") and w["WorkspaceId"] == cfg.workspace_id
              and w["WorkloadStatus"] not in TERMINAL and w.get("scheduled") is not False
              and (w["requested_gpu"] is None or w["requested_gpu"] > 0)}
    # Host CPU/RAM covers every running workload, including CPU-only ones.
    running = {w["WorkloadId"]: w for w in workloads
               if w["WorkloadType"] in HOST_METRICS and w["WorkspaceId"] == cfg.workspace_id
               and w["WorkloadStatus"] == "Running" and w.get("scheduled") is not False}
    if len(active) > cfg.max_workloads:
        errors["workload_limit"] = "budget_exceeded"
    def collect_workload(item):
        wid, w = item
        for key, metric in METRICS.items():
            def collect_metric(w=w, wid=wid, key=key, metric=metric):
                now = time.time()
                raw = client.metrics(w["WorkloadType"], wid, metric, now)
                rows = normalize_metrics(raw, cfg, wid, key, now)
                if raw and not rows:
                    raise CollectionError("invalid_dimensions")
                store.put_metrics(rows, now - cfg.retention_hours * 3600)
                return [{"sampled_at": max(r[1] for r in rows), "points": len(rows)}] if rows else []
            fetch("metric:" + wid + ":" + key, collect_metric)
    with ThreadPoolExecutor(max_workers=cfg.concurrency) as executor:
        list(executor.map(collect_workload, list(active.items())[:cfg.max_workloads]))

    # DLC job details: new or queued jobs first, bounded per round, cached otherwise.
    jobs = [w for w in workloads if w["WorkloadType"] == "dlc" and w["WorkspaceId"] == cfg.workspace_id
            and w["WorkloadStatus"] not in TERMINAL]
    jobs.sort(key=lambda w: (w.get("scheduled") is not False, "job:" + w["WorkloadId"] in previous))
    budget = [cfg.max_job_details]
    def collect_job(w):
        name = "job:" + w["WorkloadId"]
        refresh = cfg.queued_job_refresh_s if w.get("scheduled") is False else cfg.job_refresh_s
        old = previous.get(name, {})
        if old.get("state") == "ok" and started - (old.get("fetched_at") or 0) < refresh:
            seen.add(name)
            return
        with client.lock:
            if budget[0] <= 0:
                seen.add(name)
                return
            budget[0] -= 1
        fetch(name, lambda: client.job(w["WorkloadId"]), job_row)
    with ThreadPoolExecutor(max_workers=cfg.concurrency) as executor:
        list(executor.map(collect_job, jobs[:cfg.max_workloads]))

    host_interval = min(cfg.host_metric_interval_s, cfg.metric_window_s - 120)
    def collect_host(item):
        wid, w = item
        for key, metric in HOST_METRICS[w["WorkloadType"]].items():
            def collect_metric(w=w, wid=wid, key=key, metric=metric):
                now = time.time()
                raw = client.metrics(w["WorkloadType"], wid, metric, now)
                rows = normalize_metrics(raw, cfg, wid, key, now, per_gpu=False)
                if raw and not rows:
                    raise CollectionError("invalid_dimensions")
                store.put_metrics(rows, now - cfg.retention_hours * 3600)
                return [{"sampled_at": max(r[1] for r in rows), "points": len(rows)}] if rows else []
            fetch("metric:" + wid + ":" + key, collect_metric, min_interval=host_interval)
    with ThreadPoolExecutor(max_workers=cfg.concurrency) as executor:
        list(executor.map(collect_host, list(running.items())[:cfg.max_workloads]))

    # Optional attribution comes after operational monitoring, sharing the same call/time
    # budget. Save one atomic, whitelisted snapshot; incomplete pagination cannot replace it.
    from .attribution import feature_memberships
    def memberships():
        if "quotas" in errors:
            raise CollectionError("incomplete_quotas")
        return feature_memberships(client.members()[0], client.quota_roles()[0], quota_rows, cfg.quota_id)
    fetch("feature_memberships", memberships, cache=True, empty_ok=True)

    # Bounded ranking history: observed scheduled resources plus hourly metric sums.
    try:
        now = time.time()
        # A retained snapshot is useful on screen but is not evidence of continued running.
        observed = [] if "workloads" in errors else running.values()
        store.record_usage([{**w, "gpus": w.get("scheduled_gpu") if w.get("scheduled_gpu") is not None else w.get("requested_gpu"),
                             "cpu": w.get("requested_cpu"), "mem_gib": w.get("requested_mem_gib")}
                            for w in observed], now, 2 * cfg.degraded_interval_s,
                           workload_snapshot=False if "workloads" in errors else workloads)
        store.record_quota_usage([] if "quotas" in errors else quota_rows, now, 2 * cfg.degraded_interval_s,
                                 snapshot_complete="quotas" not in errors)
        store.refresh_utilization(now)
    except sqlite3.Error:
        errors["usage"] = "store_error"
    summary = {"ok": not errors, "started_at": started, "finished_at": time.time(),
               "duration_s": round(time.time() - started, 3), "calls": client.calls,
               "errors": errors, "active_sources": sorted(seen),
               "metric_workloads": min(len(active), cfg.max_workloads),
               "expected_metric_workloads": len(active)}
    store.save("round", summary, state="ok" if not errors else "partial")
    # Derive from existing local snapshots only; this adds no cloud API calls.
    try:
        from .view import overview
        store.record_cluster_usage(overview(store, cfg, time.time())["summary"], time.time(), 2 * cfg.degraded_interval_s)
    except (sqlite3.Error, ValueError):
        errors["cluster_history"] = "store_error"
        summary["ok"] = False
        store.save("round", summary, state="partial")
    return summary


def main(argv=None):
    # The independent web account reads snapshots through a shared group; never world-readable.
    os.umask(0o027)
    parser = argparse.ArgumentParser(description="PAI read-only collector")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--rounds", type=int, default=0, help="Stop after N rounds; 0 runs until interrupted")
    args = parser.parse_args(argv)
    cfg = load_pai_settings()
    if not cfg.enabled:
        parser.error("PAI is disabled; configure a separate pai.toml")
    store = PaiStore(cfg.db_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    # Separate process lock prevents overlapping collectors, including --once runs.
    with Path(cfg.db_path + ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("A PAI collector already owns this database")
        store.initialize()
        count = bad = good = 0
        interval = cfg.poll_interval_s
        while True:
            summary = run_once(cfg, store)
            count += 1
            good = good + 1 if summary["ok"] else 0
            bad = bad + 1 if not summary["ok"] else 0
            limited = "rate_limited" in summary["errors"].values()
            # CLI does not expose Retry-After. Conservatively back off 10 min on throttling.
            if limited:
                interval = max(600, interval * 2)
            elif bad >= 2:
                interval = max(interval, cfg.degraded_interval_s)
            elif good >= 2:
                interval = cfg.poll_interval_s
            summary["next_interval_s"] = interval
            store.save("round", summary, state="ok" if summary["ok"] else "partial")
            print(json.dumps({k: v for k, v in summary.items() if k != "active_sources"}), flush=True)
            if args.once or (args.rounds and count >= args.rounds):
                return 0 if summary["ok"] else 1
            time.sleep(max(1, interval - summary.get("duration_s", 0)))


if __name__ == "__main__":
    raise SystemExit(main())
