"""数据库自动备份。

职责：
- 由 systemd timer 每天 04:00 触发
- 保留指定数量的备份（默认 3 个）
- 使用 SQLite backup API 在线写临时文件，自检、fsync 后再原子发布
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path

from ..config import db_path, load_settings


def backup_dir() -> Path:
    """备份目录：data/backups/"""
    d = db_path().parent / "backups"
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def _quick_check(path: Path) -> None:
    uri = f"{path.resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        rows = [row[0] for row in conn.execute("PRAGMA quick_check")]
    finally:
        conn.close()
    if rows != ["ok"]:
        raise sqlite3.DatabaseError("临时备份 quick_check 未通过")


def _fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _new_backup_paths(directory: Path) -> tuple[Path, Path]:
    """用微秒和 O_EXCL 避免并发手工备份覆盖同名成品。"""
    for _ in range(100):
        ts = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S_%f")
        dest = directory / f"gpumon_{ts}.db"
        tmp = directory / f".{dest.name}.tmp"
        try:
            fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        os.close(fd)
        return dest, tmp
    raise FileExistsError("无法分配唯一的备份临时文件名")


def backup_now() -> Path:
    """生成并原子发布一份经过 quick_check 的 0600 SQLite 在线备份。"""
    src = db_path()
    if not src.exists():
        raise FileNotFoundError(f"数据库不存在: {src}")

    directory = backup_dir()
    dest, tmp = _new_backup_paths(directory)
    src_conn: sqlite3.Connection | None = None
    dest_conn: sqlite3.Connection | None = None
    try:
        # mode=ro 保证备份命令不会意外修改或创建源数据库。
        src_uri = f"{src.resolve().as_uri()}?mode=ro"
        src_conn = sqlite3.connect(src_uri, uri=True)
        dest_conn = sqlite3.connect(tmp)
        with dest_conn:
            src_conn.backup(dest_conn)
        dest_conn.close()
        dest_conn = None
        src_conn.close()
        src_conn = None

        _quick_check(tmp)
        os.chmod(tmp, 0o600)
        _fsync_file(tmp)
        os.replace(tmp, dest)
        _fsync_dir(directory)
    except BaseException:
        if dest_conn is not None:
            dest_conn.close()
        if src_conn is not None:
            src_conn.close()
        tmp.unlink(missing_ok=True)
        raise

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
    if not 1 <= keep <= 1000:
        raise ValueError("keep 必须在 1..1000 之间")
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
