"""数据库自动备份。

职责：
- 每天指定时间备份数据库（默认凌晨 4 点）
- 保留指定数量的备份（默认 3 个）
- 使用 SQLite backup API（在线备份，不阻塞写入）
"""
from __future__ import annotations

import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from ..config import db_path, load_settings


def backup_dir() -> Path:
    """备份目录：data/backups/"""
    d = db_path().parent / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def backup_now() -> Path:
    """立即备份数据库，返回备份文件路径。使用 SQLite backup API（在线备份）。"""
    src = db_path()
    if not src.exists():
        raise FileNotFoundError(f"数据库不存在: {src}")

    # 备份文件名：gpumon_YYYYMMDD_HHMMSS.db
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = backup_dir() / f"gpumon_{ts}.db"

    # 使用 SQLite backup API（在线备份，不阻塞写入）
    src_conn = sqlite3.connect(src)
    dest_conn = sqlite3.connect(dest)
    try:
        with dest_conn:
            src_conn.backup(dest_conn)
    finally:
        src_conn.close()
        dest_conn.close()

    return dest


def list_backups() -> list[Path]:
    """列出所有备份文件，按时间倒序（最新的在前）。"""
    backups = sorted(backup_dir().glob("gpumon_*.db"), reverse=True)
    return backups


def prune_old_backups(keep: int | None = None) -> list[Path]:
    """删除超过 keep 数量的旧备份，返回被删除的文件列表。

    keep 为 None 时从配置读取，默认 3。
    """
    if keep is None:
        keep = load_settings().backup.keep_count
    backups = list_backups()
    to_delete = backups[keep:]
    for f in to_delete:
        f.unlink()
    return to_delete


def backup_and_prune(keep: int | None = None) -> tuple[Path, list[Path]]:
    """备份 + 清理旧备份，返回 (新备份路径, 被删除的备份列表)。

    keep 为 None 时从配置读取，默认 3。
    """
    new_backup = backup_now()
    deleted = prune_old_backups(keep)
    return new_backup, deleted
