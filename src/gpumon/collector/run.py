"""采集编排：按主机调度、独立时间戳、完成即写库，慢查询降频与定时聚合。"""
from __future__ import annotations

import asyncio
import time

from ..config import load_inventory, load_settings
from ..db.rollup import Rollup
from ..db.store import Store
from ..models import ProbeResult
from .ssh import probe
from .policy import PollState

MAX_GPUS_PER_ROUND = 16_384
MAX_PROCESSES_PER_ROUND = 65_536


class _RoundBudget:
    """限制一轮中长期保留的解析对象；调用方必须在两个 await 之间同步调用。"""

    def __init__(self) -> None:
        self.gpus = 0
        self.procs = 0

    def apply(self, result: ProbeResult) -> ProbeResult:
        if not result.ok:
            return result

        gpu_count = len(result.gpus)
        if self.gpus + gpu_count > MAX_GPUS_PER_ROUND:
            result.ok = False
            result.gpus, result.procs = [], []
            result.error = f"本轮 GPU 样本超过总上限({MAX_GPUS_PER_ROUND})"
            if result.host_reachable is not None:
                result.gpu_status = "error"
            return result
        self.gpus += gpu_count

        proc_count = len(result.procs)
        if self.procs + proc_count > MAX_PROCESSES_PER_ROUND:
            warning = (
                f"本轮进程样本超过总上限({MAX_PROCESSES_PER_ROUND})，"
                "已省略本机进程明细"
            )
            if result.warning:
                warning = f"{result.warning}; {warning}"
            # GPU 与主机指标仍然有效；只释放内存放大最明显的进程对象。
            result.procs = []
            result.apps_ok = False
            result.warning = warning[:512]
            return result

        self.procs += proc_count
        return result


def _hosts(host_filter: str | None):
    """产出 (host_key, ssh_alias, vendor)。host_filter 非空时只取该 key。"""
    for c, h, _gc in load_inventory().iter_hosts():
        if c.status != "active" or h.status != "active":
            continue
        if host_filter and h.key != host_filter:
            continue
        yield h.key, h.ssh_alias, h.vendor


async def _probe_one(key, alias, vendor, state, cfg, sem, budget):
    async with sem:
        start = time.monotonic()
        attempted = start >= state.due
        result = await probe(key, alias, vendor or state.vendor, gpu_enabled=attempted)
        result = budget.apply(result)
        state.finish(result, cfg, start, time.monotonic(), time.time(), attempted)
        return result


def _states(store, cfg):
    saved = {s["key"]: s for s in store.get_collector_status()}
    return {k: PollState.restore(cfg, saved.get(k, {}), time.time(), time.monotonic())
            for k, _, _ in _hosts(None)}


async def _probe_all(host_filter: str | None = None, store: Store | None = None) -> tuple[int, list[ProbeResult]]:
    cfg = load_settings().collector
    sem = asyncio.Semaphore(cfg.max_concurrency)
    budget = _RoundBudget()
    states = _states(store, cfg) if store else {}
    tasks = [_probe_one(k, a, v, states.get(k, PollState(cfg.poll_interval_s)), cfg, sem, budget)
             for k, a, v in _hosts(host_filter)]
    results = []
    for task in asyncio.as_completed(tasks):
        result = await task
        if store:
            store.record_round(int(time.time()), [result])
        results.append(result)
    return int(time.time()), results


def _summary(ts: int, results: list[ProbeResult]) -> str:
    ok = [r for r in results if r.ok]
    bad = [r for r in results if not r.ok and not (r.gpu_status == "skipped" and r.host_reachable)]
    lines = [f"[{time.strftime('%H:%M:%S', time.localtime(ts))}] "
             f"成功 {len(ok)}/{len(results)} 机，"
             f"采到 {sum(len(r.gpus) for r in ok)} 卡，"
             f"{sum(len(r.procs) for r in ok)} 进程"]
    for r in bad:
        lines.append(f"  ✗ {r.host_key}: {r.error}")
    for r in ok:
        if r.gpu_status in ("slow", "timeout", "recovering", "error", "unknown"):
            lines.append(f"  ⚠ {r.host_key}: GPU {r.gpu_status}, {r.gpu_elapsed_s}s, "
                         f"查询间隔 {r.gpu_poll_interval_s}s")
        if r.warning:
            lines.append(f"  ⚠ {r.host_key}: {r.warning}")
    return "\n".join(lines)


def run_once(host_filter: str | None = None) -> int:
    store = Store()
    store.init_schema()
    store.sync_topology()
    ts, results = asyncio.run(_probe_all(host_filter, store))
    Rollup(store).roll_all(ts)
    print(_summary(ts, results))
    return 0 if any(r.ok or r.host_reachable for r in results) else 1


def run_forever() -> int:
    store = Store()
    store.init_schema()
    store.sync_topology()
    rollup = Rollup(store)
    cfg = load_settings().collector
    interval = cfg.poll_interval_s

    print(f"采集器启动：每 {interval}s 一轮，{sum(1 for _ in _hosts(None))} 台主机。")
    async def loop():
        states = _states(store, cfg)
        specs = {k: (a, v) for k, a, v in _hosts(None)}
        next_host = {k: time.monotonic() for k in specs}
        sem = asyncio.Semaphore(cfg.max_concurrency)
        budget = _RoundBudget()
        pending = {}
        last_roll5m = last_roll1h = last_cleanup = 0.0
        try:
            while True:
                now_m = time.monotonic()
                for key, (alias, vendor) in specs.items():
                    if key not in pending and now_m >= next_host[key]:
                        pending[key] = asyncio.create_task(
                            _probe_one(key, alias, vendor, states[key], cfg, sem, budget))
                        next_host[key] = now_m + interval
                if pending:
                    done, _ = await asyncio.wait(pending.values(), timeout=1,
                                                 return_when=asyncio.FIRST_COMPLETED)
                    for key, task in list(pending.items()):
                        if task not in done:
                            continue
                        del pending[key]
                        result = task.result()
                        ts = int(time.time())
                        store.record_round(ts, [result])
                        # Release the shared retained-object budget after persistence.
                        if result.ok:
                            budget.gpus -= len(result.gpus)
                            budget.procs -= len(result.procs)
                        next_host[key] = max(next_host[key], time.monotonic() + 1)
                        if result.gpu_status not in ("ok", "skipped") or result.warning:
                            print(_summary(ts, [result]))
                    # Completed Task objects retain their results. Drop them before
                    # admitting more probes against the released object budget.
                    done.clear()
                    task = result = None
                else:
                    await asyncio.sleep(min(1, max(0.05, min(next_host.values(), default=now_m + 1) - now_m)))
                now_m, ts = time.monotonic(), int(time.time())
                if now_m - last_roll5m >= 60:
                    rollup.roll_gpu_5m(ts); last_roll5m = now_m
                if now_m - last_roll1h >= 300:
                    rollup.roll_gpu_1h(ts); rollup.roll_host_1h(ts); last_roll1h = now_m
                if now_m - last_cleanup >= 3600:
                    rollup.cleanup(ts); last_cleanup = now_m
        finally:
            for task in pending.values():
                task.cancel()
            await asyncio.gather(*pending.values(), return_exceptions=True)

    try:
        asyncio.run(loop())
    except KeyboardInterrupt:
        print("\n采集器停止。")
    return 0
