"""Fictional PAI fixtures only. No cloud client, credentials, or runtime database reads."""
from __future__ import annotations

import math
import tempfile
from pathlib import Path

from gpumon.pai.config import PaiSettings
from gpumon.pai.store import PaiStore
from gpumon.pai.reporting import reporting_period, reporting_metadata
from gpumon.pai.view import overview


def fixtures(now: int, windows: dict[str, int], *, ranking_timezone="Asia/Shanghai", ranking_week_start="monday", ranking_reset_time="00:00") -> dict:
    now = int(now) // 120 * 120
    cfg = PaiSettings(enabled=True, account_id="0000000000000000", region="demo-region",
                      workspace_id="demo-workspace", quota_id="demo-root", ranking_timezone=ranking_timezone,
                      ranking_week_start=ranking_week_start, ranking_reset_time=ranking_reset_time)
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
            periods = {w: (now - seconds, now) for w, seconds in windows.items()}
            periods.update(week=reporting_period(now, cfg), last_week=reporting_period(now, cfg, previous=True))
            for window, (since, until) in periods.items():
                seconds = until - since
                hours = max(0, until - max(since, now - 72 * 3600)) / 3600
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
                features = []
                for q in snapshot["quotas"]:
                    members = [u for u in users if u["quotas"][0]["quota_id"] == q["quota_id"]]
                    gh = sum(u["gpu_hours"] for u in members)
                    idle = sum(u["oversold_gpu_hours"] for u in members)
                    features.append(dict(quota_id=q["quota_id"], quota_name=q["quota_name"], is_root=q["quota_id"] == "demo-root",
                        gpu_hours=gh, quota_gpu_hours=gh-idle, oversold_gpu_hours=idle,
                        effective_gpu_hours=sum(u["effective_gpu_hours"] for u in members), measured_gpu_hours=gh,
                        compute_mean=sum(u["effective_gpu_hours"] for u in members)/gh*100 if gh else None,
                        current_capacity_gpu=q["gpu_capacity"], current_used_gpu=q["gpu_used"],
                        current_occupancy_pct=q["gpu_used"]/q["gpu_capacity"]*100,
                        current_allocated_gpu=q["gpu_used"], current_borrowed_gpu=0, quota_fresh=True,
                        capacity_gpu_hours=q["gpu_capacity"]*hours, used_gpu_hours=q["gpu_used"]*hours,
                        occupancy_pct=q["gpu_used"]/q["gpu_capacity"]*100 if hours else None,
                        observed_quota_hours=hours, quota_coverage_pct=hours*3600/seconds*100 if seconds else 0,
                        workloads=sum(u["workloads"] for u in members) if hours else 0))
                features.sort(key=lambda f: -f["gpu_hours"])
                if not hours:
                    users = []
                    for f in features:
                        for key in ("gpu_hours", "quota_gpu_hours", "oversold_gpu_hours", "effective_gpu_hours", "measured_gpu_hours", "workloads"):
                            f[key] = None
                result[f"pai_ranking.{window}.json"] = dict(window=window, since=since, until=until, generated_at=now,
                    **reporting_metadata(cfg), boundary_estimate=bool(since % 3600 or (until < now and until % 3600)),
                    quota_fresh=True, features=features,
                    first_hour=now - 72 * 3600, bucket_s=3600, users=users, truncated=False, synthetic=True)
            return result
        finally:
            store.close()
