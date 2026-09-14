"""Shared host reachability and GPU collection health, including cached API data."""


def host_health(row: dict, now: int, base_interval: int = 30,
                *, window_s: int | None = None) -> tuple[bool, str]:
    window = max(120, base_interval * 4) if window_s is None else window_s
    heartbeat = row.get("last_heartbeat_ts") or row.get("last_ok_ts")
    last_try = row.get("last_try_ts") or row.get("last_ok_ts")
    if last_try is None or not 0 <= now - last_try <= window:
        return False, "unknown"
    if heartbeat is None or not 0 <= now - heartbeat <= window:
        return False, "offline"
    state = row.get("gpu_status")
    if state in ("error", "unknown"):
        return True, "gpu_error"
    if state in ("slow", "timeout", "recovering") or (row.get("gpu_poll_interval_s") or base_interval) > base_interval:
        return True, "overloaded"
    return True, "online"
