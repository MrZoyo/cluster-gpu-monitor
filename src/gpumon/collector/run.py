"""采集编排：并发轮询所有主机，单机故障隔离，同轮共用一个 ts，写库 + 定时聚合。"""
from __future__ import annotations

import asyncio
import time

from ..config import load_inventory, load_settings
from ..db.rollup import Rollup
from ..db.store import Store
from ..models import ProbeResult
from .ssh import probe


def _hosts(host_filter: str | None):
    """产出 (host_key, ssh_alias, vendor)。host_filter 非空时只取该 key。"""
    for c, h, _gc in load_inventory().iter_hosts():
        if c.status != "active" or h.status != "active":
            continue
        if host_filter and h.key != host_filter:
            continue
        yield h.key, h.ssh_alias, h.vendor


async def _probe_all(host_filter: str | None = None) -> tuple[int, list[ProbeResult]]:
    """并发采集所有主机；返回 (本轮统一 ts, 结果列表)。"""
    sem = asyncio.Semaphore(load_settings().collector.max_concurrency)
    ts = int(time.time())   # 一轮共用同一 ts，利于跨机对齐与全局聚合

    async def one(key: str, alias: str, vendor: str | None) -> ProbeResult:
        async with sem:
            return await probe(key, alias, vendor)

    tasks = [one(k, a, v) for k, a, v in _hosts(host_filter)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    # gather 的异常兜底（probe 内部已尽量自包，这里再防一层）
    clean: list[ProbeResult] = []
    host_keys = [k for k, _, _ in _hosts(host_filter)]
    for key, r in zip(host_keys, results):
        if isinstance(r, ProbeResult):
            clean.append(r)
        else:
            clean.append(ProbeResult(host_key=key, ok=False, error=f"任务异常: {r}"))
    return ts, clean


def _summary(ts: int, results: list[ProbeResult]) -> str:
    ok = [r for r in results if r.ok]
    bad = [r for r in results if not r.ok]
    lines = [f"[{time.strftime('%H:%M:%S', time.localtime(ts))}] "
             f"成功 {len(ok)}/{len(results)} 机，"
             f"采到 {sum(len(r.gpus) for r in ok)} 卡，"
             f"{sum(len(r.procs) for r in ok)} 进程"]
    for r in bad:
        lines.append(f"  ✗ {r.host_key}: {r.error}")
    return "\n".join(lines)


def run_once(host_filter: str | None = None) -> int:
    store = Store()
    store.init_schema()
    store.sync_topology()
    ts, results = asyncio.run(_probe_all(host_filter))
    store.record_round(ts, results)
    Rollup(store).roll_all(ts)
    print(_summary(ts, results))
    return 0 if any(r.ok for r in results) else 1


def run_forever() -> int:
    store = Store()
    store.init_schema()
    store.sync_topology()
    rollup = Rollup(store)
    cfg = load_settings().collector
    interval = cfg.poll_interval_s

    print(f"采集器启动：每 {interval}s 一轮，{sum(1 for _ in _hosts(None))} 台主机。")
    next_tick = time.monotonic()
    last_roll5m = last_roll1h = last_cleanup = 0.0

    async def loop():
        nonlocal next_tick, last_roll5m, last_roll1h, last_cleanup
        while True:
            ts, results = await _probe_all()
            try:
                store.record_round(ts, results)
            except Exception as e:  # 写库异常不应杀死采集循环
                print(f"写库失败: {e}")

            now_m = time.monotonic()
            if now_m - last_roll5m >= 60:
                rollup.roll_gpu_5m(ts); last_roll5m = now_m
            if now_m - last_roll1h >= 300:
                rollup.roll_gpu_1h(ts); rollup.roll_host_1h(ts); last_roll1h = now_m
            if now_m - last_cleanup >= 3600:
                rollup.cleanup(ts); last_cleanup = now_m

            bad = [r for r in results if not r.ok]
            if bad:
                print(_summary(ts, results))

            next_tick += interval               # 防累积漂移
            sleep = next_tick - time.monotonic()
            if sleep < 0:                        # 落后太多则重置基准
                next_tick = time.monotonic()
                sleep = 0
            await asyncio.sleep(sleep)

    try:
        asyncio.run(loop())
    except KeyboardInterrupt:
        print("\n采集器停止。")
    return 0
