"""Per-host cooldown, independent of wall-clock jumps while the collector runs."""
from dataclasses import dataclass

from ..models import CollectorSettings, ProbeResult


@dataclass
class PollState:
    interval: int
    due: float = 0
    fast: int = 0
    vendor: str | None = None
    degraded: bool = False

    @classmethod
    def restore(cls, cfg: CollectorSettings, saved: dict, wall: float, mono: float):
        interval = max(cfg.poll_interval_s, saved.get("gpu_poll_interval_s") or 0)
        # Bound persisted cooldown after a wall-clock change; never catch up missed probes.
        delay = min(max(0, (saved.get("next_gpu_try_ts") or 0) - wall), interval)
        return cls(interval, mono + delay, saved.get("fast_successes") or 0,
                   saved.get("vendor"), saved.get("gpu_status") in ("slow", "timeout", "error", "unknown", "recovering"))

    def finish(self, result: ProbeResult, cfg: CollectorSettings,
               start: float, end: float, wall: float, attempted: bool):
        if result.vendor in ("nvidia", "amd") and result.gpus:
            self.vendor = result.vendor
        if not attempted:
            result.gpu_status = "skipped"
        if attempted:
            result.sample_interval_s = self.interval
            if result.gpu_status in ("slow", "timeout", "error", "unknown") or not result.ok:
                self.interval = max(cfg.poll_interval_s, cfg.gpu_backoff_s)
                self.fast = 0
                self.degraded = True
            elif result.gpu_status == "ok":
                if result.gpu_elapsed_s is not None and result.gpu_elapsed_s < cfg.gpu_recover_s:
                    self.fast = min(cfg.gpu_recover_count, self.fast + 1)
                    if self.fast >= cfg.gpu_recover_count:
                        self.interval = cfg.poll_interval_s
                        self.degraded = False
                else:
                    self.fast = 0
                if self.degraded:
                    result.gpu_status = "recovering"
            self.due = max(start + self.interval, end + 1)
        result.gpu_poll_interval_s = self.interval
        result.next_gpu_try_ts = wall + max(0, self.due - end)
        result.fast_successes = self.fast
