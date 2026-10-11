from __future__ import annotations

import logging
import sqlite3
import time

from fastapi import APIRouter, HTTPException, Query, Response

from ..db.store import WINDOWS
from ..pai.config import load_pai_settings
from ..pai.store import PaiStore
from ..pai.values import number
from ..pai.reporting import reporting_period, reporting_metadata
from ..pai.view import overview
from .deps import mask_username, valid_window
from .query_control import bounded_query

router = APIRouter(prefix="/api/pai", tags=["pai"])
log = logging.getLogger(__name__)


def pai_enabled() -> bool:
    """Register /api/pai/* only when pai.toml explicitly enables PAI.

    Disabled (the public default) means the routes do not exist at all: every PAI path is a
    plain 404 and the web UI behaves as the bare-metal monitor. An invalid config also keeps
    PAI off so a PAI problem can never take the bare-metal site down.
    """
    try:
        return load_pai_settings().enabled
    except (ValueError, OSError):
        log.warning("Invalid PAI config; PAI API stays disabled")
        return False


def snapshot():
    try:
        cfg = load_pai_settings()
        if not cfg.enabled:
            return {"enabled": False, "state": "disabled"}
        store = PaiStore(cfg.db_path, read_only=True)
        if not store.path.exists():
            return {"enabled": True, "state": "waiting"}
        data = overview(store, cfg, time.time())
        for w in data["workloads"]:
            w["UserName"] = mask_username(w.get("UserName"))
        for u in data["users"]:
            u["Username"] = mask_username(u.get("Username"))
        for n in data["nodes"]:
            n.pop("ResourceGroupId", None)
            for c in n["cards"]:
                for a in c["assignments"]:
                    a["owner_name"] = mask_username(a.get("owner_name"))
        return data
    except (sqlite3.Error, ValueError, OSError):
        raise HTTPException(503, "PAI snapshot unavailable") from None


@router.get("/overview")
def pai_overview(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return snapshot()


@router.get("/status")
def pai_status(response: Response):
    response.headers["Cache-Control"] = "no-store"
    data = snapshot()
    return {k: data[k] for k in ("enabled", "state", "sources", "summary", "poll_interval_s", "baremetal_notice") if k in data}


@router.get("/nodes")
def pai_nodes(response: Response):
    return collection("nodes", response)


@router.get("/workloads")
def pai_workloads(response: Response):
    return collection("workloads", response)


@router.get("/users")
def pai_users(response: Response):
    return collection("users", response)


def collection(key, response):
    response.headers["Cache-Control"] = "no-store"
    data = snapshot()
    return {k: data[k] for k in ("enabled", "state", "sources", key) if k in data}


@router.get("/metrics/series")
def pai_series(response: Response, workload_id: str = Query(min_length=1, max_length=128),
               hours: int = Query(default=1, ge=1, le=6)):
    response.headers["Cache-Control"] = "no-store"
    cfg = load_pai_settings()
    if not cfg.enabled:
        raise HTTPException(404, "PAI disabled")
    try:
        return PaiStore(cfg.db_path, read_only=True).series(workload_id, time.time(), hours)
    except (sqlite3.Error, OSError):
        raise HTTPException(503, "PAI series unavailable") from None


@router.get("/ranking")
@bounded_query
def pai_ranking(response: Response, window: str = Query("week")):
    """Feature and user rankings, with observed quota denominators (<= 32 days)."""
    response.headers["Cache-Control"] = "no-store"
    now = time.time()
    cfg = load_pai_settings()
    if not cfg.enabled:
        raise HTTPException(404, "PAI disabled")
    if window in ("week", "last_week"):
        since, until = reporting_period(now, cfg, previous=window == "last_week")
    else:
        window = valid_window(window)
        since, until = int(now - WINDOWS[window]) // 3600 * 3600, now
    try:
        store = PaiStore(cfg.db_path, read_only=True)
        data = store.ranking(until, until - since, since=since, observed_until=now)
        cluster_history = store.cluster_ranking(since, until, observed_until=now)
        quota_history = store.quota_ranking(since, until, observed_until=now)
        sources = store.sources()
        quota_source = sources.get("quotas", {})
        quota_rows = quota_source.get("payload") or []
        quota_names = {q.get("quota_id"): q.get("quota_name") for q in quota_rows}
    except (sqlite3.Error, OSError):
        raise HTTPException(503, "PAI ranking unavailable") from None
    source_fresh = lambda key: sources.get(key, {}).get("state") == "ok" and now - (sources.get(key, {}).get("fetched_at") or 0) <= cfg.stale_after_s
    node_counts = [number(n.get("GPU")) for n in (sources.get("nodes", {}).get("payload") or [])]
    capacity = sum(node_counts) if node_counts and all(n is not None and n.is_integer() and 0 <= n <= 128 for n in node_counts) else None
    running = [w for w in (sources.get("workloads", {}).get("payload") or [])
               if w.get("WorkloadStatus") == "Running" and w.get("scheduled") is not False]
    counts = [(w.get("scheduled_gpu") if w.get("scheduled_gpu") is not None else w.get("requested_gpu"), w.get("oversold")) for w in running]
    occupied = sum(n for n, _ in counts) if all(n is not None and n >= 0 for n, _ in counts) else None
    current_fresh = source_fresh("nodes") and source_fresh("workloads")
    current_pool = {"capacity_gpu": capacity, "occupied_gpu": occupied,
                    "borrowed_gpu": sum(n for n, borrowed in counts if borrowed) if all(n is not None and n >= 0 for n, borrowed in counts if borrowed) else None, "fresh": current_fresh,
                    "occupancy_pct": occupied / capacity * 100 if capacity and occupied is not None and occupied <= capacity else None,
                    "scope": "monitored_workspace_workloads_over_physical_pool"}
    users = {}
    hours = lambda s: (s or 0) / 3600
    for r in data["rows"]:
        u = users.setdefault(r["user_id"], {"user_id": r["user_id"], "username": mask_username(r["user_name"]),
            "gpu_hours": 0, "oversold_gpu_hours": 0, "effective_gpu_hours": 0, "measured_gpu_hours": 0,
            "cpu_core_hours": 0, "mem_gib_hours": 0, "workloads": 0, "quotas": [],
            "_sums": {k: 0 for k in ("compute_sum", "compute_n", "gmem_sum", "gmem_n",
                                     "cpu_util_sum", "cpu_util_n", "ram_util_sum", "ram_util_n")}})
        u["gpu_hours"] += hours(r["gpu_s"])
        u["oversold_gpu_hours"] += hours(r["oversold_gpu_s"])
        u["effective_gpu_hours"] += hours(r["effective_gpu_s"])
        u["measured_gpu_hours"] += hours(r["measured_gpu_s"])
        u["cpu_core_hours"] += hours(r["cpu_s"])
        u["mem_gib_hours"] += hours(r["mem_gib_s"])
        u["workloads"] += r["workloads"]
        u["quotas"].append({"quota_id": r["quota_id"], "quota_name": quota_names.get(r["quota_id"], r["quota_id"]),
                            "gpu_hours": hours(r["gpu_s"] - (r["oversold_gpu_s"] or 0)),
                            "oversold_gpu_hours": hours(r["oversold_gpu_s"])})
        for k in u["_sums"]:
            u["_sums"][k] += r[k] or 0
    result = []
    for u in users.values():
        sums = u.pop("_sums")
        avg = lambda key: sums[key + "_sum"] / sums[key + "_n"] if sums[key + "_n"] else None
        u.update(compute_mean=avg("compute"), gpu_memory_mean=avg("gmem"),
                 cpu_util_mean=avg("cpu_util"), ram_util_mean=avg("ram_util"))
        result.append(u)
    result.sort(key=lambda u: (-u["gpu_hours"], -u["cpu_core_hours"], u["username"] or ""))
    # Retain submission quotas in user breakdowns and the separate root row. Feature
    # attribution is an overlapping reporting view; totals come from raw usage once.
    from ..pai.attribution import membership_status
    memberships, attribution = membership_status(sources, cfg, now)
    features = {}
    fresh = quota_source.get("state") == "ok" and now - (quota_source.get("fetched_at") or 0) <= cfg.stale_after_s
    def feature(qid):
        return features.setdefault(qid, {"quota_id": qid, "quota_name": quota_names.get(qid) or qid or "未归属",
            "is_root": qid == cfg.quota_id, "rank": None,
            "direct_gpu_hours": 0, "root_attributed_gpu_hours": 0,
            "gpu_hours": 0, "oversold_gpu_hours": 0,
            "quota_gpu_hours": 0, "effective_gpu_hours": 0, "measured_gpu_hours": 0,
            "cpu_core_hours": 0, "mem_gib_hours": 0, "workloads": 0,
            "compute_mean": None, "gpu_memory_mean": None, "cpu_util_mean": None, "ram_util_mean": None,
            "current_capacity_gpu": None, "current_used_gpu": None, "current_occupancy_pct": None,
            "current_allocated_gpu": None, "current_ancestor_allocated_gpu": None, "current_borrowed_gpu": None, "quota_fresh": False,
            "observed_quota_hours": 0, "capacity_gpu_hours": None, "used_gpu_hours": None,
            "occupancy_pct": None, "quota_coverage_pct": 0, "quota_first_hour": None})
    for q in quota_rows:
        f = feature(q["quota_id"])
        f["quota_fresh"] = fresh
        f["current_capacity_gpu"] = q.get("gpu_capacity")
        f["current_used_gpu"] = q.get("gpu_used")
        f["current_allocated_gpu"] = q.get("allocated_gpu")
        f["current_ancestor_allocated_gpu"] = q.get("ancestors_allocated_gpu")
        f["current_borrowed_gpu"] = f["current_ancestor_allocated_gpu"]  # Legacy alias; not oversold donor data.
        cap, used = q.get("gpu_capacity"), q.get("gpu_used")
        f["current_occupancy_pct"] = used / cap * 100 if cap and used is not None else None
    root = feature(cfg.quota_id)
    root["unattributed_gpu_hours"] = 0
    totals = {k: 0 for k in ("gpu_hours", "oversold_gpu_hours", "effective_gpu_hours", "measured_gpu_hours",
                             "cpu_core_hours", "mem_gib_hours", "workloads")}
    unresolved = {}
    sums = {}
    def add_usage(f, r):
        for dest, source in (("gpu_hours", "gpu_s"), ("oversold_gpu_hours", "oversold_gpu_s"),
                             ("effective_gpu_hours", "effective_gpu_s"), ("measured_gpu_hours", "measured_gpu_s"),
                             ("cpu_core_hours", "cpu_s"), ("mem_gib_hours", "mem_gib_s")):
            f[dest] += hours(r[source])
        f["workloads"] += r["workloads"]
    for r in data["rows"]:
        add_usage(totals, r)
        direct = feature(r["quota_id"])
        direct["direct_gpu_hours"] += hours(r["gpu_s"])
        targets = [direct]
        if r["quota_id"] == cfg.quota_id:
            candidates = memberships.get(r["user_id"], [])
            if len(candidates) == 1:
                target = feature(candidates[0])
                target["root_attributed_gpu_hours"] += hours(r["gpu_s"])
                root["root_attributed_gpu_hours"] += hours(r["gpu_s"])
                targets.append(target)
            else:
                reason = "membership_unavailable" if not attribution["fresh"] else "multiple_features" if len(candidates) > 1 else "no_feature_role"
                unresolved[reason] = unresolved.get(reason, 0) + hours(r["gpu_s"])
                root["unattributed_gpu_hours"] += hours(r["gpu_s"])
        for f in targets:
            add_usage(f, r)
            acc = sums.setdefault(f["quota_id"], {})
            for col in ("compute", "gmem", "cpu_util", "ram_util"):
                for suffix in ("_sum", "_n"):
                    key = col + suffix
                    acc[key] = acc.get(key, 0) + (r[key] or 0)
    for f in features.values():
        f["quota_gpu_hours"] = f["gpu_hours"] - f["oversold_gpu_hours"]
        acc = sums.get(f["quota_id"], {})
        for dest, col in (("compute_mean", "compute"), ("gpu_memory_mean", "gmem"),
                          ("cpu_util_mean", "cpu_util"), ("ram_util_mean", "ram_util")):
            f[dest] = acc[col + "_sum"] / acc[col + "_n"] if acc.get(col + "_n") else None
    for r in quota_history:
        f = feature(r["quota_id"])
        if r["quota_id"] not in quota_names:
            f["quota_name"] = r["quota_name"] or f["quota_name"]
        f.update(observed_quota_hours=hours(r["observed_s"]), capacity_gpu_hours=hours(r["capacity_gpu_s"]),
                 used_gpu_hours=hours(r["used_gpu_s"]), quota_first_hour=r["first_hour"],
                 occupancy_pct=r["used_gpu_s"] / r["capacity_gpu_s"] * 100 if r["capacity_gpu_s"] else None,
                 quota_coverage_pct=min(100, r["observed_s"] / (until - since) * 100) if until > since else 0)
    ordered = sorted((f for f in features.values() if not f["is_root"]),
                     key=lambda f: (-f["gpu_hours"], -f["cpu_core_hours"], f["quota_name"]))
    known = data["first_hour"] is not None and data["first_hour"] < until
    for rank, f in enumerate(ordered, 1):
        f["rank"] = rank if known else None
    if not known:
        for f in [*ordered, root, totals]:
            for key in ("gpu_hours", "quota_gpu_hours", "oversold_gpu_hours", "effective_gpu_hours",
                        "measured_gpu_hours", "cpu_core_hours", "mem_gib_hours", "workloads",
                        "direct_gpu_hours", "root_attributed_gpu_hours", "unattributed_gpu_hours"):
                if key in f:
                    f[key] = None
    attribution["unresolved_root_gpu_hours"] = unresolved if known else None
    for row in [*result, *ordered, root, totals]:
        measured, occupied = row["measured_gpu_hours"], row["gpu_hours"]
        row["hardware_efficiency_pct"] = row["effective_gpu_hours"] / measured * 100 if measured else None
        row["gpu_metric_coverage_pct"] = min(100, measured / occupied * 100) if measured is not None and occupied else None
        row["borrowed_gpu_hours"] = row["oversold_gpu_hours"]
    return {"window": window, "since": since, "until": until, "cluster": cluster_history, "current_pool": current_pool,
            "efficiency_method": "gpu_minute_samples_capped_by_observed_allocation",
            "resource_semantics": "owned_pool_borrowing_not_additional_capacity",
            "generated_at": now,
            **reporting_metadata(cfg), "first_hour": data["first_hour"],
            "boundary_estimate": bool(since % 3600 or (until < now and until % 3600)),
            "bucket_s": 3600, "users": result[:200], "features": ordered[:200],
            "root_quota": root, "totals": totals, "feature_attribution": attribution,
            "user_quota_basis": "submission_quota", "root_quota_usage_scope": "direct_submissions",
            "quota_fetched_at": quota_source.get("fetched_at"), "quota_fresh": fresh,
            "truncated": len(result) > 200 or len(ordered) > 200 or data["truncated"]}
