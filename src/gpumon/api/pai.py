from __future__ import annotations

import logging
import sqlite3
import time

from fastapi import APIRouter, HTTPException, Query, Response

from ..db.store import WINDOWS
from ..pai.config import load_pai_settings
from ..pai.store import PaiStore
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
def pai_ranking(response: Response, window: str = Query("24h")):
    """Per-user resource-hours from the bounded hourly history (<= 32 days)."""
    response.headers["Cache-Control"] = "no-store"
    window = valid_window(window)
    cfg = load_pai_settings()
    if not cfg.enabled:
        raise HTTPException(404, "PAI disabled")
    try:
        store = PaiStore(cfg.db_path, read_only=True)
        data = store.ranking(time.time(), WINDOWS[window])
        quota_names = {q.get("quota_id"): q.get("quota_name")
                       for q in (store.sources().get("quotas", {}).get("payload") or [])}
    except (sqlite3.Error, OSError):
        raise HTTPException(503, "PAI ranking unavailable") from None
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
    return {"window": window, "since": data["since"], "first_hour": data["first_hour"],
            "bucket_s": 3600, "users": result[:200], "truncated": len(result) > 200}
