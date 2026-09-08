"""Anonymous recent GPU utilization: shared cache and bounded per-IP admission."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from ipaddress import ip_address
import math
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..config import load_settings
from ..db.store import current_sample_max_age_s
from .deps import get_store
from .query_control import bounded_query
from .routes import _topology_with_inventory_placeholders

PATH = "/api/v1/gpu-summary"
CACHE_TTL_S = 30
MIN_INTERVAL_S = 10
MAX_CLIENTS = 4096
router = APIRouter()


def _unavailable():
    return HTTPException(503, "GPU summary temporarily unavailable",
                         headers={"Retry-After": "10", "Cache-Control": "no-store"})


def _client_ip(request: Request) -> str:
    # The ASGI server resolves only trusted proxy hops. Never read a client-
    # supplied X-Forwarded-For or CF-Connecting-IP header here.
    try:
        address = ip_address(request.client.host if request.client else "")
    except ValueError:
        raise _unavailable() from None
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    return str(address)


@bounded_query
def _load_snapshot(now: int) -> dict:
    store = get_store()
    topology, _, cluster_meta, host_meta = _topology_with_inventory_placeholders()
    recent = store.get_util_recent(now=now)
    sample_times = store.get_gpu_sample_times()
    statuses = {s["key"]: s for s in store.get_collector_status(now=now)}
    hosts = []
    for cluster in topology:
        cluster_active = cluster_meta.get(cluster["key"], {}).get("status", "active") == "active"
        for host in cluster["hosts"]:
            meta = host_meta.get(host["key"], {})
            status = statuses.get(host["key"], {})
            by_index = {g["gpu_index"]: g for g in host["gpus"]}
            indices = sorted(set(range(host["gpu_count"])) | set(by_index))
            gpus = []
            for index in indices:
                gpu = by_index.get(index, {})
                gid = gpu.get("id")
                gpus.append({
                    "index": index,
                    "model": gpu.get("name"),
                    "util_recent_pct": recent.get(gid),
                    "sampled_at": sample_times.get(gid),
                })
            hosts.append({
                "name": host["display_name"],
                "active": cluster_active and meta.get("status", "active") == "active",
                "last_ok_ts": status.get("last_ok_ts"),
                "gpus": gpus,
            })
    return {
        "as_of": now,
        "poll_interval_s": load_settings().collector.poll_interval_s,
        "sample_max_age_s": current_sample_max_age_s(),
        "hosts": hosts,
    }


def _common_or_list(values: list):
    """Store a shared value once; retain per-GPU differences when present."""
    return values[0] if values and all(value == values[0] for value in values) else values


def _render(snapshot: dict, now: int) -> dict:
    hosts = []
    for host in snapshot["hosts"]:
        last_ok = host["last_ok_ts"]
        online = bool(host["active"] and last_ok is not None and 0 <= now - last_ok <= 120)
        indices, models, timestamps, utilization = [], [], [], []
        for gpu in host["gpus"]:
            ts = gpu["sampled_at"]
            fresh = online and ts is not None and 0 <= now - ts <= snapshot["sample_max_age_s"]
            value = gpu["util_recent_pct"] if fresh else None
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            indices.append(gpu["index"])
            models.append(gpu["model"])
            timestamps.append(ts)
            utilization.append(value)
        row = {
            "name": host["name"], "model": _common_or_list(models), "online": online,
            "sampled_at": _common_or_list(timestamps), "util_pct": utilization,
        }
        if indices != list(range(len(indices))):
            row["indices"] = indices
        hosts.append(row)
    return {"as_of": snapshot["as_of"], "hosts": hosts}

class SummaryService:
    """One cache and limiter per Web process; gpumon web runs one worker.

    Admission and refresh share a lock so concurrent cache misses do one query.
    Expired client entries are removed in insertion order; live entries are
    never evicted to admit a new IP. Failed requests do not consume a cooldown.
    """

    def __init__(self, *, loader=None, clock=None, wall_clock=None):
        self._loader = loader or _load_snapshot
        self._clock = clock or time.monotonic
        self._wall_clock = wall_clock or time.time
        self._lock = threading.Lock()
        self._clients: OrderedDict[str, float] = OrderedDict()
        self._snapshot = None
        self._cached_at = 0.0

    def get(self, client_ip: str) -> JSONResponse:
        if not self._lock.acquire(timeout=1):
            raise _unavailable()
        try:
            now = self._clock()
            while self._clients and next(iter(self._clients.values())) <= now:
                self._clients.popitem(last=False)
            allowed_at = self._clients.get(client_ip)
            if allowed_at is not None:
                raise HTTPException(
                    429, "Request interval must be at least 10 seconds",
                    headers={"Retry-After": str(max(1, math.ceil(allowed_at - now))),
                             "Cache-Control": "no-store"},
                )
            if len(self._clients) >= MAX_CLIENTS:
                raise _unavailable()
            if self._snapshot is None or now - self._cached_at >= CACHE_TTL_S:
                try:
                    snapshot = self._loader(int(self._wall_clock()))
                except Exception:
                    # Public errors must not contain database paths, SSH errors
                    # or configuration values. Do not serve an expired fallback.
                    raise _unavailable() from None
                self._snapshot = deepcopy(snapshot)
                self._cached_at = self._clock()
            response = JSONResponse(
                _render(self._snapshot, int(self._wall_clock())),
                headers={"Cache-Control": "no-store"},
            )
            self._clients[client_ip] = self._clock() + MIN_INTERVAL_S
            return response
        finally:
            self._lock.release()


@router.get(PATH, include_in_schema=True)
def gpu_summary(request: Request):
    if request.query_params:
        raise HTTPException(400, "This endpoint does not accept query parameters",
                            headers={"Cache-Control": "no-store"})
    return request.app.state.gpu_summary.get(_client_ip(request))
