"""聚合与保留清理。

三层：sample_gpu(原始~30s) → rollup_gpu_5m → rollup_gpu_1h；sample_host → rollup_host_1h。
只处理“已封口”的桶（now 已越过桶尾），用 rollup_state 水位增量推进，避免每次全表扫。
1h 表从 5m 表按 n 加权聚合（不是对均值再平均），保证与原始 AVG 一致。
"""
from __future__ import annotations

import time

from ..config import load_settings
from .store import Store


class Rollup:
    def __init__(self, store: Store | None = None, *, sample_interval_s: int | None = None):
        self.store = store or Store()
        if sample_interval_s is not None and (
            isinstance(sample_interval_s, bool) or not isinstance(sample_interval_s, int)
            or not 1 <= sample_interval_s <= 86_400
        ):
            raise ValueError("sample_interval_s 必须是 1..86400 的整数")
        self.sample_interval_s = sample_interval_s

    def _interval(self) -> int:
        # Synthetic generation supplies its own fixed cadence and must not read
        # deployment settings. Live collection retains the configured default.
        return self.sample_interval_s or load_settings().collector.poll_interval_s

    def _get_wm(self, conn, name: str) -> int:
        row = conn.execute("SELECT watermark FROM rollup_state WHERE name=?", (name,)).fetchone()
        return row[0] if row else 0

    def _set_wm(self, conn, name: str, value: int) -> None:
        conn.execute(
            "INSERT INTO rollup_state(name,watermark) VALUES(?,?) "
            "ON CONFLICT(name) DO UPDATE SET watermark=excluded.watermark", (name, value))

    def roll_gpu_5m(self, now: int) -> None:
        conn = self.store.write_conn()
        b_max = ((now - 300) // 300) * 300          # 最后一个已封口的 5m 桶起点
        if b_max < 0:
            return
        with conn:
            wm = self._get_wm(conn, "gpu_5m")
            interval = self._interval()
            conn.execute(f"""
                INSERT OR REPLACE INTO rollup_gpu_5m
                  (gpu_id,bucket_ts,n,util_gpu_avg,util_gpu_max,util_mem_avg,
                   mem_used_avg,mem_used_max,temp_avg,temp_max,power_avg,weight_s,util_gpu_weight_s,util_mem_weight_s,mem_used_weight_s,temp_weight_s,power_weight_s)
                SELECT gpu_id,(ts/300)*300 AS b,COUNT(*),
                       SUM(util_gpu*w)/SUM(CASE WHEN util_gpu IS NOT NULL THEN w END),MAX(util_gpu),
                       SUM(util_mem*w)/SUM(CASE WHEN util_mem IS NOT NULL THEN w END),
                       SUM(mem_used_mib*w)/SUM(CASE WHEN mem_used_mib IS NOT NULL THEN w END),MAX(mem_used_mib),
                       SUM(temp_c*w)/SUM(CASE WHEN temp_c IS NOT NULL THEN w END),MAX(temp_c),
                       SUM(power_w*w)/SUM(CASE WHEN power_w IS NOT NULL THEN w END),SUM(w),
                       SUM(CASE WHEN util_gpu IS NOT NULL THEN w ELSE 0 END),
                       SUM(CASE WHEN util_mem IS NOT NULL THEN w ELSE 0 END),
                       SUM(CASE WHEN mem_used_mib IS NOT NULL THEN w ELSE 0 END),
                       SUM(CASE WHEN temp_c IS NOT NULL THEN w ELSE 0 END),
                       SUM(CASE WHEN power_w IS NOT NULL THEN w ELSE 0 END)
                FROM (
                    SELECT s.*,COALESCE(sw.seconds,{interval}) AS w FROM sample_gpu s
                    LEFT JOIN sample_weight sw ON sw.gpu_id=s.gpu_id AND sw.ts=s.ts
                    WHERE s.ts>=? AND s.ts<?
                ) GROUP BY gpu_id,b HAVING b<=?
            """, (wm, b_max + 300, b_max))
            self._set_wm(conn, "gpu_5m", b_max)

    def roll_gpu_1h(self, now: int) -> None:
        conn = self.store.write_conn()
        b_max = ((now - 3600) // 3600) * 3600
        if b_max < 0:
            return
        with conn:
            wm = self._get_wm(conn, "gpu_1h")
            interval = self._interval()
            conn.execute(f"""
                INSERT OR REPLACE INTO rollup_gpu_1h
                  (gpu_id,bucket_ts,n,util_gpu_avg,util_gpu_max,util_mem_avg,
                   mem_used_avg,mem_used_max,temp_avg,temp_max,power_avg,weight_s,util_gpu_weight_s,util_mem_weight_s,mem_used_weight_s,temp_weight_s,power_weight_s)
                SELECT gpu_id,(bucket_ts/3600)*3600 AS b,SUM(n),
                       SUM(util_gpu_avg*COALESCE(util_gpu_weight_s,w))/SUM(CASE WHEN util_gpu_avg IS NOT NULL THEN COALESCE(util_gpu_weight_s,w) END),MAX(util_gpu_max),
                       SUM(util_mem_avg*COALESCE(util_mem_weight_s,w))/SUM(CASE WHEN util_mem_avg IS NOT NULL THEN COALESCE(util_mem_weight_s,w) END),
                       SUM(mem_used_avg*COALESCE(mem_used_weight_s,w))/SUM(CASE WHEN mem_used_avg IS NOT NULL THEN COALESCE(mem_used_weight_s,w) END),MAX(mem_used_max),
                       SUM(temp_avg*COALESCE(temp_weight_s,w))/SUM(CASE WHEN temp_avg IS NOT NULL THEN COALESCE(temp_weight_s,w) END),MAX(temp_max),
                       SUM(power_avg*COALESCE(power_weight_s,w))/SUM(CASE WHEN power_avg IS NOT NULL THEN COALESCE(power_weight_s,w) END),SUM(w),
                       SUM(COALESCE(util_gpu_weight_s,w)),SUM(COALESCE(util_mem_weight_s,w)),
                       SUM(COALESCE(mem_used_weight_s,w)),SUM(COALESCE(temp_weight_s,w)),SUM(COALESCE(power_weight_s,w))
                FROM (
                    SELECT *,COALESCE(weight_s,n*{interval}) AS w FROM rollup_gpu_5m
                    WHERE bucket_ts>=? AND bucket_ts<?
                ) GROUP BY gpu_id,b HAVING b<=?
            """, (wm, b_max + 3600, b_max))
            self._set_wm(conn, "gpu_1h", b_max)

    def roll_host_1h(self, now: int) -> None:
        conn = self.store.write_conn()
        b_max = ((now - 3600) // 3600) * 3600
        if b_max < 0:
            return
        with conn:
            wm = self._get_wm(conn, "host_1h")
            conn.execute("""
                INSERT OR REPLACE INTO rollup_host_1h(host_id,bucket_ts,n,cpu_util_avg,load1_avg,mem_used_avg)
                SELECT host_id,(ts/3600)*3600 AS b,COUNT(*),AVG(cpu_util_pct),AVG(load1),AVG(mem_used_mib)
                FROM sample_host WHERE ts>=? AND ts<? GROUP BY host_id,b HAVING b<=?
            """, (wm, b_max + 3600, b_max))
            self._set_wm(conn, "host_1h", b_max)

    def cleanup(self, now: int) -> None:
        ret = load_settings().retention
        raw_cut = now - ret.raw_days * 86400
        r5m_cut = now - ret.rollup_5m_days * 86400
        r1h_cut = now - ret.rollup_1h_days * 86400
        conn = self.store.write_conn()
        with conn:
            conn.execute("DELETE FROM sample_weight WHERE ts<?", (raw_cut,))
            conn.execute("DELETE FROM sample_gpu WHERE ts<?", (raw_cut,))
            conn.execute("DELETE FROM sample_proc WHERE ts<?", (raw_cut,))
            conn.execute("DELETE FROM sample_host WHERE ts<?", (raw_cut,))
            conn.execute("DELETE FROM rollup_gpu_5m WHERE bucket_ts<?", (r5m_cut,))
            # 1 小时聚合此前无上限增长；按 rollup_1h_days 回收（须 > 最长时间窗）
            conn.execute("DELETE FROM rollup_gpu_1h WHERE bucket_ts<?", (r1h_cut,))
            conn.execute("DELETE FROM rollup_host_1h WHERE bucket_ts<?", (r1h_cut,))
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def roll_all(self, now: int | None = None) -> None:
        now = int(now or time.time())
        self.roll_gpu_5m(now)
        self.roll_gpu_1h(now)
        self.roll_host_1h(now)

    def run_all(self, now: int | None = None) -> None:
        """聚合 + 清理（rollup-once CLI 用）。"""
        now = int(now or time.time())
        self.roll_all(now)
        self.cleanup(now)
