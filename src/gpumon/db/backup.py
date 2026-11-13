"""数据库自动备份。

职责：
- 由 systemd timer 每天 04:00 触发
- 保留指定数量的备份（默认 3 个）
- 使用 SQLite backup API 在线写临时文件，自检、fsync 后再原子发布
- 写入前确认磁盘放得下整库副本；尽力清理自己的临时文件
"""
from __future__ import annotations

import errno
import os
import re
import shutil
import sqlite3
import stat
import time
from datetime import datetime
from pathlib import Path

from ..config import db_path, load_settings

_BACKUP_PREFIX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_MIB = 1024 ** 2
# 备份期间和之后，正在运行的数据库仍要写入：整库副本之外再留 20%，至少 256 MiB。
_SPACE_HEADROOM_MIN = 256 * _MIB
_SIDECARS = ("-wal", "-shm", "-journal")
# 本模块产生的文件旁的 SQLite 伴生文件：成品 <前缀>_<时间>.db 或临时副本 .<成品名>.tmp 加后缀。
_OWN_SIDECAR = re.compile(
    r"^(?P<main>(?P<temp>\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}_[0-9]{8}_[0-9]{6}_[0-9]{6}\.db(?(temp)\.tmp))"
    r"(?:-wal|-shm|-journal)$"
)
# 本模块的临时副本：.<前缀>_<时间>.db.tmp。
_OWN_TEMP = re.compile(r"^\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}_[0-9]{8}_[0-9]{6}_[0-9]{6}\.db\.tmp$")
# 进行中的备份的主文件一直存在，这是清理时的主要保护；年龄只是额外筛选，不是活动性证明。
_ORPHAN_AGE_S = 24 * 3600


def backup_dir() -> Path:
    """备份目录：data/backups/"""
    d = db_path().parent / "backups"
    return _prepare_backup_dir(d)


def _prepare_backup_dir(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or not stat.S_ISDIR(directory.lstat().st_mode):
        raise ValueError(f"备份路径必须是普通目录且不能是 symlink: {directory}")
    os.chmod(directory, 0o700)
    return directory


def _regular_source(source: Path) -> Path:
    if source.is_symlink():
        raise ValueError(f"数据库不能是 symlink: {source}")
    try:
        source_stat = source.lstat()
    except FileNotFoundError:
        raise FileNotFoundError(f"数据库不存在: {source}") from None
    if not stat.S_ISREG(source_stat.st_mode):
        raise ValueError(f"数据库必须是普通文件: {source}")
    return source.resolve(strict=True)


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


def _require_space(source: Path, directory: Path) -> None:
    """整库副本放不下时在写入前拒绝。

    写满磁盘会让正在写库的采集器出错，备份自身也必然失败。这是一次即时检查，不预留空间。
    """
    need = source.stat().st_size
    try:
        wal = source.with_name(source.name + "-wal").lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISREG(wal.st_mode):
            need += wal.st_size
    need += max(_SPACE_HEADROOM_MIN, need // 5)
    free = shutil.disk_usage(directory).free
    if free < need:
        raise OSError(
            errno.ENOSPC,
            f"备份需要约 {need // _MIB} MiB，磁盘可用仅 {free // _MIB} MiB；未写入备份",
            str(directory),
        )


def _remove_sidecars(path: Path) -> None:
    """尽力删除某个文件旁的 SQLite 伴生文件；只删普通文件，失败不抛出。

    它只在主文件已确定不再使用时调用，属于收尾，不能掩盖调用方真正的结果或异常。
    """
    for suffix in _SIDECARS:
        sidecar = path.with_name(path.name + suffix)
        try:
            if stat.S_ISREG(sidecar.lstat().st_mode):
                sidecar.unlink()
        except OSError:
            continue


def _settle_temp(tmp: Path) -> None:
    """发布前收拾临时副本的伴生文件。

    源库是 WAL 模式时副本也是，只读自检会在它旁边留下空的 -wal / -shm；改名后它们就成了
    无主文件。副本由本进程独占地写入一个新文件，内容此时应全部在主文件里；-wal 非空说明
    这个前提不成立，拒绝发布而不是丢弃。这不是任意 SQLite 文件都适用的规则。
    """
    try:
        pending = tmp.with_name(tmp.name + "-wal").lstat().st_size
    except FileNotFoundError:
        pending = 0
    if pending:
        raise sqlite3.DatabaseError("临时备份仍有未合并的 WAL 内容，拒绝发布")
    _remove_sidecars(tmp)


def _sweep_orphan_sidecars(directory: Path) -> list[Path]:
    """清掉以往备份留下的无主伴生文件，返回已删除的文件；尽力而为。

    只删同时满足以下条件的普通文件：名称是本模块产生的文件加 -wal/-shm/-journal；
    超过一天没有改动；删除前再次确认它的主文件不存在。主文件（成品、临时副本，包括被中断
    后留下的）从不删除：仅凭名称和时间无法证明一个数据库文件没有人在用。
    """
    removed: list[Path] = []
    try:
        with os.scandir(directory) as scan:
            names = [entry.name for entry in scan]
    except OSError:
        return removed
    cutoff = time.time() - _ORPHAN_AGE_S
    for name in names:
        match = _OWN_SIDECAR.fullmatch(name)
        if not match:
            continue
        sidecar = directory / name
        try:
            info = sidecar.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mtime >= cutoff:
                continue
            try:
                (directory / match["main"]).lstat()
            except FileNotFoundError:
                sidecar.unlink()
                removed.append(sidecar)
        except OSError:
            continue
    return removed


def stale_temp_copies(directory: Path) -> list[tuple[Path, int]]:
    """目录中超过一天未改动的临时副本候选及其大小，供操作者核对。

    只读、只报告：不创建或修改任何东西，不删除，出任何文件系统错误都返回已得到的结果而
    不抛出。它们通常是被中断的备份留下的，但名称和时间不足以证明无人使用。
    """
    found: list[tuple[Path, int]] = []
    try:
        cutoff = time.time() - _ORPHAN_AGE_S
        with os.scandir(directory) as scan:
            for entry in scan:
                if not _OWN_TEMP.fullmatch(entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                    found.append((Path(entry.path), info.st_size))
    except OSError:
        pass
    return sorted(found)


def _new_backup_paths(directory: Path, prefix: str = "gpumon") -> tuple[Path, Path]:
    """用微秒和 O_EXCL 避免并发手工备份覆盖同名成品。"""
    if not _BACKUP_PREFIX.fullmatch(prefix):
        raise ValueError("备份文件前缀不合法")
    for _ in range(100):
        ts = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S_%f")
        dest = directory / f"{prefix}_{ts}.db"
        tmp = directory / f".{dest.name}.tmp"
        try:
            fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        os.close(fd)
        return dest, tmp
    raise FileExistsError("无法分配唯一的备份临时文件名")


def backup_database(source: str | Path, *, directory: str | Path | None = None,
                    prefix: str = "gpumon") -> Path:
    """安全备份任意显式 SQLite 普通文件，供受控维护脚本复用。"""
    src = _regular_source(Path(source))
    target_dir = _prepare_backup_dir(
        Path(directory) if directory is not None else src.parent / "backups"
    )
    if not _BACKUP_PREFIX.fullmatch(prefix):
        raise ValueError("备份文件前缀不合法")
    _require_space(src, target_dir)
    dest, tmp = _new_backup_paths(target_dir, prefix)
    src_conn: sqlite3.Connection | None = None
    dest_conn: sqlite3.Connection | None = None
    try:
        # mode=ro 保证备份命令不会意外修改或创建源数据库。
        src_uri = f"{src.as_uri()}?mode=ro"
        src_conn = sqlite3.connect(src_uri, uri=True)
        dest_conn = sqlite3.connect(tmp)
        with dest_conn:
            src_conn.backup(dest_conn)
        dest_conn.close()
        dest_conn = None
        src_conn.close()
        src_conn = None

        _quick_check(tmp)
        _settle_temp(tmp)
        os.chmod(tmp, 0o600)
        _fsync_file(tmp)
        os.replace(tmp, dest)
        _fsync_dir(target_dir)
    except BaseException:
        if dest_conn is not None:
            dest_conn.close()
        if src_conn is not None:
            src_conn.close()
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass  # 保留真正的失败原因
        _remove_sidecars(tmp)
        raise

    return dest


def backup_now() -> Path:
    """生成并原子发布一份经过 quick_check 的 0600 SQLite 在线备份。"""
    directory = backup_dir()
    dest = backup_database(db_path(), directory=directory)
    # 只在本功能自己管理的目录里收拾旧残留；调用方显式指定的目录不做任何清理。
    _sweep_orphan_sidecars(directory)
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
        # 有人打开过这份备份时 SQLite 会在旁边留下伴生文件，随备份一起清掉。
        _remove_sidecars(f)
    return to_delete


def backup_and_prune(keep: int | None = None) -> tuple[Path, list[Path]]:
    """备份 + 清理旧备份，返回 (新备份路径, 被删除的备份列表)。

    keep 为 None 时从配置读取，默认 3。
    """
    new_backup = backup_now()
    deleted = prune_old_backups(keep)
    return new_backup, deleted
