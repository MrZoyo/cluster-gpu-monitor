"""Independent SQLite snapshots and bounded source-time metrics. Web opens mode=ro."""
from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
from pathlib import Path
from contextlib import contextmanager

# Host CPU/RAM metrics are pod-level; GPU metrics are per card. Column prefix per stored metric name.
UTIL_COLUMNS = {"compute": "compute", "memory": "gmem", "cpu": "cpu_util", "ram": "ram_util"}
USAGE_RETENTION_S = 32 * 86400


class PaiStore:
    def __init__(self, path, read_only=False):
        self.path = Path(path)
        self.read_only = read_only
        self._writer = None
        self._lock = threading.RLock()

    @contextmanager
    def connect(self):
        if not self.read_only:
            # The collector keeps one long-lived writer. Closing the last connection deletes
            # the WAL/SHM files, and a mode=ro reader that opens at that moment fails.
            with self._lock:
                if self._writer is None:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    self._writer = sqlite3.connect(self.path, timeout=2, check_same_thread=False)
                    self._writer.row_factory = sqlite3.Row
                conn = self._writer
                deadline = time.monotonic() + 5
                conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
                with conn:
                    yield conn
            return
        conn = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        conn.execute("PRAGMA query_only=ON")
        conn.row_factory = sqlite3.Row
        deadline = time.monotonic() + 2
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def close(self):
        with self._lock:
            if self._writer is not None:
                self._writer.close()
                self._writer = None

    def initialize(self):
        with self.connect() as c:
            c.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS source (
                    name TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT 'null',
                    fetched_at REAL, attempted_at REAL NOT NULL, state TEXT NOT NULL,
                    total INTEGER, error TEXT);
                CREATE TABLE IF NOT EXISTS metric (
                    series_id TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
                    workload_id TEXT NOT NULL, pod TEXT NOT NULL, gpu TEXT NOT NULL,
                    metric TEXT NOT NULL, fetched_at REAL NOT NULL,
                    PRIMARY KEY(series_id, ts));
                CREATE INDEX IF NOT EXISTS metric_expiry ON metric(ts);
                CREATE INDEX IF NOT EXISTS metric_workload ON metric(workload_id, ts);
                -- Bounded history for rankings: one row per workload per UTC hour, kept 32 days.
                -- *_s are resource-seconds observed by the collector; *_sum/*_n are metric
                -- sums and sample counts recomputed from raw points, so averages stay weighted.
                CREATE TABLE IF NOT EXISTS usage_hour (
                    hour INTEGER NOT NULL, workload_id TEXT NOT NULL,
                    user_id TEXT, user_name TEXT, quota_id TEXT, workload_type TEXT,
                    run_s REAL NOT NULL DEFAULT 0, gpu_s REAL NOT NULL DEFAULT 0,
                    oversold_gpu_s REAL NOT NULL DEFAULT 0, cpu_s REAL NOT NULL DEFAULT 0,
                    mem_gib_s REAL NOT NULL DEFAULT 0,
                    compute_sum REAL NOT NULL DEFAULT 0, compute_n INTEGER NOT NULL DEFAULT 0,
                    gmem_sum REAL NOT NULL DEFAULT 0, gmem_n INTEGER NOT NULL DEFAULT 0,
                    cpu_util_sum REAL NOT NULL DEFAULT 0, cpu_util_n INTEGER NOT NULL DEFAULT 0,
                    ram_util_sum REAL NOT NULL DEFAULT 0, ram_util_n INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(hour, workload_id));
                CREATE TABLE IF NOT EXISTS quota_hour (
                    hour INTEGER NOT NULL, quota_id TEXT NOT NULL, quota_name TEXT,
                    observed_s REAL NOT NULL, capacity_gpu_s REAL NOT NULL, used_gpu_s REAL NOT NULL,
                    PRIMARY KEY(hour, quota_id));
                CREATE TABLE IF NOT EXISTS quota_cursor (
                    quota_id TEXT PRIMARY KEY, quota_name TEXT, observed_at REAL NOT NULL,
                    capacity REAL NOT NULL, used REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS usage_cursor (
                    workload_id TEXT PRIMARY KEY, observed_at REAL NOT NULL);
            """)

    def save(self, name, data, total=None, state="ok", now=None):
        now = time.time() if now is None else now
        with self.connect() as c:
            c.execute("""INSERT INTO source VALUES (?,?,?,?,?,?,NULL)
                ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,
                fetched_at=excluded.fetched_at, attempted_at=excluded.attempted_at,
                state=excluded.state, total=excluded.total, error=NULL""",
                      (name, json.dumps(data, allow_nan=False), now, now, state, total))

    def failure(self, name, error, now=None):
        now = time.time() if now is None else now
        with self.connect() as c:
            c.execute("""INSERT INTO source(name,attempted_at,state,error) VALUES (?,?,'error',?)
                ON CONFLICT(name) DO UPDATE SET attempted_at=excluded.attempted_at,
                state='error', error=excluded.error""", (name, now, error))

    def sources(self):
        with self.connect() as c:
            rows = c.execute("SELECT * FROM source ORDER BY name LIMIT 2000").fetchall()
        return {r["name"]: {**dict(r), "payload": json.loads(r["payload"])} for r in rows}

    def put_metrics(self, rows, cutoff):
        with self.connect() as c:
            c.executemany("""INSERT INTO metric VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(series_id,ts) DO UPDATE SET value=excluded.value,
                fetched_at=excluded.fetched_at""", rows)
            c.execute("DELETE FROM metric WHERE ts < ?", (cutoff,))
            c.execute("DELETE FROM source WHERE (name LIKE 'metric:%' OR name LIKE 'pods:%' OR name LIKE 'job:%') AND attempted_at < ?", (cutoff,))

    def series(self, workload_id, now, hours=1):
        # At most 128 cards * 2 metrics * 60 points in the default one-hour view.
        with self.connect() as c:
            rows = c.execute("""SELECT * FROM metric WHERE workload_id=? AND ts>=?
                ORDER BY ts LIMIT 20001""", (workload_id, now - hours * 3600)).fetchall()
        truncated = len(rows) > 20000
        buckets = {}
        for r in rows[:20000]:
            bucket = (r["series_id"], r["ts"] // 120 * 120)
            if bucket not in buckets:
                buckets[bucket] = {"series_id": r["series_id"], "ts": bucket[1],
                    "pod": r["pod"], "gpu": r["gpu"], "metric": r["metric"],
                    "sum": 0, "count": 0, "max": r["value"], "latest": r["value"],
                    "sampled_at": r["ts"]}
            b = buckets[bucket]
            b["sum"] += r["value"]
            b["count"] += 1
            b["max"] = max(b["max"], r["value"])
            if r["ts"] >= b["sampled_at"]:
                b["latest"], b["sampled_at"] = r["value"], r["ts"]
        points = []
        for b in buckets.values():
            b["mean"] = b.pop("sum") / b["count"]
            b["coverage"] = min(1, b["count"] / 2)
            points.append(b)
        return {"points": points, "truncated": truncated, "bucket_s": 120,
                "source_period_s": 60, "attribution": "workload_pod_gpu_only"}

    def recent_means(self, now, window_s=600):
        """Per-series mean and point count over the last window (matches bare-metal 10-min util_recent)."""
        with self.connect() as c:
            rows = c.execute("""SELECT series_id, AVG(value) mean, COUNT(*) n FROM metric
                WHERE ts >= ? GROUP BY series_id LIMIT 10000""", (now - window_s,)).fetchall()
        return {r["series_id"]: (r["mean"], r["n"]) for r in rows}

    def latest_metrics(self, now):
        with self.connect() as c:
            rows = c.execute("""SELECT m.* FROM metric m JOIN
                (SELECT series_id, MAX(ts) ts FROM metric WHERE ts>=? GROUP BY series_id) x
                ON m.series_id=x.series_id AND m.ts=x.ts LIMIT 10000""", (now - 3600,)).fetchall()
        return [dict(r) for r in rows]

    # ---- usage history ----------------------------------------------------------
    def record_usage(self, workloads, now, max_gap):
        """Add observed running time since the previous round, split across UTC hours.

        Only observed intervals count: a gap longer than ``max_gap`` (collector down) adds at
        most ``max_gap``, and a newly seen workload counts back at most ``max_gap`` from its
        dequeue time. Resource-seconds use scheduled amounts, not utilization.
        """
        with self.connect() as c:
            cursors = dict(c.execute("SELECT workload_id, observed_at FROM usage_cursor").fetchall())
            for w in workloads:
                wid = w["WorkloadId"]
                dequeued = w.get("dequeued_at")
                start = cursors.get(wid, dequeued if dequeued is not None else now)
                start = max(start, now - max_gap, dequeued if dequeued is not None else start)
                t = start
                while t < now:
                    hour = int(t // 3600 * 3600)
                    end = min(now, hour + 3600)
                    secs = end - t
                    c.execute("""INSERT INTO usage_hour(hour, workload_id, user_id, user_name, quota_id, workload_type,
                            run_s, gpu_s, oversold_gpu_s, cpu_s, mem_gib_s) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(hour, workload_id) DO UPDATE SET user_id=excluded.user_id,
                            user_name=excluded.user_name, quota_id=excluded.quota_id,
                            workload_type=excluded.workload_type, run_s=run_s+excluded.run_s,
                            gpu_s=gpu_s+excluded.gpu_s, oversold_gpu_s=oversold_gpu_s+excluded.oversold_gpu_s,
                            cpu_s=cpu_s+excluded.cpu_s, mem_gib_s=mem_gib_s+excluded.mem_gib_s""",
                              (hour, wid, w.get("UserId"), w.get("UserName"), w.get("QuotaId"), w.get("WorkloadType"),
                               secs, (w.get("gpus") or 0) * secs, (w.get("gpus") or 0) * secs if w.get("oversold") else 0,
                               (w.get("cpu") or 0) * secs, (w.get("mem_gib") or 0) * secs))
                    t = end
                c.execute("""INSERT INTO usage_cursor VALUES (?,?)
                    ON CONFLICT(workload_id) DO UPDATE SET observed_at=excluded.observed_at""", (wid, now))
            c.execute("DELETE FROM usage_cursor WHERE observed_at < ?", (now - 7 * 86400,))
            c.execute("DELETE FROM usage_hour WHERE hour < ?", (now - USAGE_RETENTION_S,))

    def refresh_utilization(self, now, hours=3):
        """Recompute metric sums for recent hours from raw points (idempotent; late points included)."""
        since = (int(now) // 3600 - hours + 1) * 3600
        with self.connect() as c:
            rows = c.execute("""SELECT workload_id, metric, ts / 3600 * 3600 AS hour, SUM(value) s, COUNT(*) n
                FROM metric WHERE ts >= ? GROUP BY workload_id, metric, hour LIMIT 20000""", (since,)).fetchall()
            for r in rows:
                col = UTIL_COLUMNS.get(r["metric"])
                if col:
                    c.execute(f"UPDATE usage_hour SET {col}_sum=?, {col}_n=? WHERE hour=? AND workload_id=?",
                              (r["s"], r["n"], r["hour"], r["workload_id"]))

    def record_quota_usage(self, quotas, now, max_gap):
        """Integrate the previous observed quota values; never backfill before first sight.

        Missing/failed sources clear cursors. Long gaps count only the first max_gap
        seconds after the previous observation, so outages are not counted as zero usage.
        """
        valid = {}
        for q in quotas:
            cap, used = q.get("gpu_capacity"), q.get("gpu_used")
            if all(isinstance(v, (int, float)) and not isinstance(v, bool) and
                   math.isfinite(v) and v >= 0 for v in (cap, used)):
                valid[q["quota_id"]] = q
        with self.connect() as c:
            previous = {r["quota_id"]: dict(r) for r in c.execute("SELECT * FROM quota_cursor")}
            for qid, q in valid.items():
                old = previous.get(qid)
                if old and now <= old["observed_at"]:
                    continue
                if old:
                    t = old["observed_at"]
                    stop = min(now, t + max_gap)
                    while t < stop:
                        hour = int(t // 3600 * 3600)
                        end = min(stop, hour + 3600)
                        secs = end - t
                        c.execute("""INSERT INTO quota_hour VALUES (?,?,?,?,?,?)
                            ON CONFLICT(hour,quota_id) DO UPDATE SET quota_name=excluded.quota_name,
                                observed_s=observed_s+excluded.observed_s,
                                capacity_gpu_s=capacity_gpu_s+excluded.capacity_gpu_s,
                                used_gpu_s=used_gpu_s+excluded.used_gpu_s""",
                            (hour, qid, old["quota_name"], secs, old["capacity"] * secs, old["used"] * secs))
                        t = end
                c.execute("INSERT OR REPLACE INTO quota_cursor VALUES (?,?,?,?,?)",
                          (qid, q.get("quota_name"), now, q["gpu_capacity"], q["gpu_used"]))
            for qid in previous.keys() - valid.keys():
                c.execute("DELETE FROM quota_cursor WHERE quota_id=?", (qid,))
            c.execute("DELETE FROM quota_hour WHERE hour < ?", (now - USAGE_RETENTION_S,))

    def quota_ranking(self, since, until):
        with self.connect() as c:
            # Older databases can still be read during a rolling deployment.
            if not c.execute("SELECT 1 FROM sqlite_master WHERE name='quota_hour'").fetchone():
                return []
            rows = c.execute("""SELECT quota_id, MAX(quota_name) quota_name, MIN(hour) first_hour,
                SUM(observed_s) observed_s, SUM(capacity_gpu_s) capacity_gpu_s, SUM(used_gpu_s) used_gpu_s
                FROM quota_hour WHERE hour >= ? AND hour < ? GROUP BY quota_id LIMIT 1000""",
                (since, until)).fetchall()
        return [dict(r) for r in rows]

    def ranking(self, now, window_s, *, since=None, group_by="user"):
        since = int(now - window_s) // 3600 * 3600 if since is None else since
        grouping = "user_id, quota_id" if group_by == "user" else "quota_id"
        with self.connect() as c:
            rows = c.execute(f"""SELECT user_id, MAX(user_name) AS user_name, quota_id,
                    SUM(gpu_s) gpu_s, SUM(oversold_gpu_s) oversold_gpu_s, SUM(cpu_s) cpu_s, SUM(mem_gib_s) mem_gib_s,
                    SUM(CASE WHEN compute_n > 0 THEN gpu_s * compute_sum / compute_n / 100 END) effective_gpu_s,
                    SUM(CASE WHEN compute_n > 0 THEN gpu_s END) measured_gpu_s,
                    SUM(compute_sum) compute_sum, SUM(compute_n) compute_n, SUM(gmem_sum) gmem_sum, SUM(gmem_n) gmem_n,
                    SUM(cpu_util_sum) cpu_util_sum, SUM(cpu_util_n) cpu_util_n,
                    SUM(ram_util_sum) ram_util_sum, SUM(ram_util_n) ram_util_n,
                    COUNT(DISTINCT workload_id) workloads
                FROM usage_hour WHERE hour >= ? AND hour < ? GROUP BY {grouping} LIMIT 5001""", (since, now)).fetchall()
            first = c.execute("SELECT MIN(hour) FROM usage_hour").fetchone()[0]
        return {"since": since, "first_hour": first, "rows": [dict(r) for r in rows[:5000]],
                "truncated": len(rows) > 5000}
