"""Fictional PAI fixtures only. No cloud client, credentials, or runtime database reads."""
from __future__ import annotations

import math
import tempfile
from pathlib import Path

from gpumon.pai.config import PaiSettings
from gpumon.pai.store import PaiStore
from gpumon.pai.view import overview


def fixtures(now: int, windows: dict[str, int]) -> dict:
    now = int(now) // 120 * 120
    cfg = PaiSettings(enabled=True, account_id="0000000000000000", region="demo-region",
                      workspace_id="demo-workspace", quota_id="demo-root")
    # Two development instances, a training job, an idle-capacity job, and a queued job.
    specs = [
        ("demo-dsw-vision", "演示 · 视觉开发", "dsw", "demo-alice", "Demo Alice", "demo-dev", 2, 36, False),
        ("demo-dlc-train", "演示 · 策略训练", "dlc", "demo-bob", "Demo Bob", "demo-train", 8, 78, False),
        ("demo-dsw-debug", "演示 · 调试环境", "dsw", "demo-alice", "Demo Alice", "demo-dev", 2, 1, False),
        ("demo-dlc-idle", "演示 · 闲时评估", "dlc", "demo-carol", "Demo Carol", "demo-train", 8, 52, True),
        ("demo-dlc-queue", "演示 · 等待资源", "dlc", "demo-carol", "Demo Carol", "demo-train", 24, 0, False),
    ]
    workloads = []
    for wid, name, kind, uid, owner, quota, gpu, util, idle in specs:
        queued = wid.endswith("queue")
        workloads.append(dict(WorkloadId=wid, WorkloadName=name, WorkloadType=kind,
            WorkloadStatus="Pending" if queued else "Running", UserId=uid, UserName=owner,
            WorkspaceId=cfg.workspace_id, QuotaId=quota, requested_gpu=gpu, scheduled_gpu=0 if queued else gpu,
            requested_cpu=gpu * 8, requested_mem_gib=gpu * 32, scheduled=not queued, oversold=idle,
            priority=3, queue_position=1 if queued else 0, enqueued_at=now - 2400 if queued else now - 86400,
            dequeued_at=None if queued else now - 86400, queue_code="QuotaCheckFail" if queued else None,
            queue_reason="演示任务：当前配额资源不足" if queued else None))
    with tempfile.TemporaryDirectory(prefix="gpumon-pai-demo-") as tmp:
        store = PaiStore(Path(tmp) / "synthetic.db")
        store.initialize()
        try:
            store.save("identity", {"AccountId": cfg.account_id}, now=now)
            store.save("workloads", workloads, now=now)
            store.save("quotas", [dict(quota_id=qid, quota_name=name, parent_quota_id=parent,
                gpu_capacity=cap, gpu_used=used, allocated_gpu=used,
                self_allocated_gpu=0 if parent is None else used,
                descendants_allocated_gpu=used if parent is None else 0,
                ancestors_allocated_gpu=0, oversold_enabled=True, status="Ready")
                for qid, name, parent, cap, used in [
                    ("demo-root", "演示资源池", None, 32, 12),
                    ("demo-dev", "演示开发配额", "demo-root", 16, 4),
                    ("demo-train", "演示训练配额", "demo-root", 16, 8)]], now=now)
            nodes = []
            for i, job in enumerate([workloads[0], workloads[1], workloads[2], None]):
                name = f"demo-node-{i + 1:02d}"
                quota = "demo-dev" if i in (0, 2) else "demo-train"
                nodes.append(dict(NodeName=name, GPU="8", GPUType="Demo GPU 80GB",
                    NodeStatus="Ready", RequestGPU=job["requested_gpu"] if job else 0,
                    health_rate=10000, bound_quotas=["demo-root", quota], ReasonCode=None))
                store.save("pods:" + name, [] if job is None else [dict(
                    WorkloadId=job["WorkloadId"], PodName=job["WorkloadId"] + "-pod",
                    GPUIndexes=list(range(job["requested_gpu"])), Phase="Running")], now=now)
            store.save("nodes", nodes, now=now)
            store.save("users", [dict(UserId=uid, Username=owner, WorkloadCount=sum(w["UserId"] == uid for w in workloads),
                used_gpu=sum(w["scheduled_gpu"] for w in workloads if w["UserId"] == uid and not w["oversold"]),
                submitted_gpu=sum(w["requested_gpu"] for w in workloads if w["UserId"] == uid))
                for uid, owner in [("demo-alice", "Demo Alice"), ("demo-bob", "Demo Bob"), ("demo-carol", "Demo Carol")]], now=now)
            rows = []
            for wid, _, kind, _, _, _, gpu, util, idle in specs:
                if kind == "dlc":
                    store.save("job:" + wid, dict(oversold_type="AcceptQuotaOverSold" if idle else "ForbiddenQuotaOverSold",
                        tide=False, aimaster=True, specs=[dict(type="Worker", pods=max(1, gpu // 8), gpu=min(gpu, 8), cpu=64, mem_gib=256)]), now=now)
                if wid.endswith("queue"):
                    continue
                for metric in ("compute", "memory", "cpu", "ram"):
                    indices = range(gpu) if metric in ("compute", "memory") else [""]
                    for index in indices:
                        sid = f"{wid}:{index}:{metric}"
                        for minute in range(61):
                            ts = now - 60 - minute * 60
                            base = {"compute": util, "memory": 62 if util > 5 else 18, "cpu": util * .6, "ram": 44}[metric]
                            value = max(0, min(100, base + math.sin(minute / 5 + (index or 0)) * min(base / 2, 9)))
                            rows.append((sid, ts, value, wid, wid + "-pod", str(index), metric, now))
                    store.save(f"metric:{wid}:{metric}", [{"sampled_at": now - 60, "points": 61 * len(indices)}], now=now)
            store.put_metrics(rows, now - 86400)
            store.save("round", {"ok": True, "finished_at": now, "duration_s": 6, "calls": 0}, now=now)
            snapshot = overview(store, cfg, now)
            snapshot["synthetic"] = True
            result = {"pai_status.json": {"enabled": True, "state": "ok", "synthetic": True}, "pai_overview.json": snapshot}
            for wid, *_ in specs:
                result[f"pai_series.{wid}.json"] = store.series(wid, now)
            for window, seconds in windows.items():
                hours = min(seconds, 72 * 3600) / 3600
                users = []
                for uid, owner, gpu, util, quota, idle in [
                    ("demo-bob", "Demo Bob", 8, 78, "demo-train", False),
                    ("demo-carol", "Demo Carol", 8, 52, "demo-train", True),
                    ("demo-alice", "Demo Alice", 4, 18.5, "demo-dev", False)]:
                    gh = gpu * hours
                    users.append(dict(user_id=uid, username=owner, gpu_hours=gh, oversold_gpu_hours=gh if idle else 0,
                        effective_gpu_hours=gh * util / 100, measured_gpu_hours=gh, cpu_core_hours=gh * 8,
                        mem_gib_hours=gh * 32, workloads=2 if uid == "demo-alice" else 1, compute_mean=util,
                        gpu_memory_mean=62, cpu_util_mean=util * .6, ram_util_mean=44,
                        quotas=[dict(quota_id=quota, quota_name="演示开发配额" if quota == "demo-dev" else "演示训练配额",
                            gpu_hours=0 if idle else gh, oversold_gpu_hours=gh if idle else 0)]))
                result[f"pai_ranking.{window}.json"] = dict(window=window, since=now - seconds,
                    first_hour=now - 72 * 3600, bucket_s=3600, users=users, truncated=False, synthetic=True)
            return result
        finally:
            store.close()
