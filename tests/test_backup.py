"""SQLite 本地备份必须先自检并原子发布，失败时不得轮换旧成品。"""
from __future__ import annotations

import errno
import os
import sqlite3
import stat
import time
from types import SimpleNamespace

import pytest

from gpumon.db import backup


@pytest.fixture
def source_db(tmp_path, monkeypatch):
    path = tmp_path / "gpumon.db"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE samples(id INTEGER PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO samples(value) VALUES ('first'), ('second')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(backup, "db_path", lambda: path)
    return path


def _read_values(path):
    conn = sqlite3.connect(path)
    try:
        return [row[0] for row in conn.execute("SELECT value FROM samples ORDER BY id")]
    finally:
        conn.close()


def test_backup_is_checked_private_and_atomically_published(source_db):
    dest = backup.backup_now()

    assert dest.parent == source_db.parent / "backups"
    assert dest.name.startswith("gpumon_") and dest.suffix == ".db"
    assert stat.S_IMODE(dest.stat().st_mode) == 0o600
    assert _read_values(dest) == ["first", "second"]
    assert not list(dest.parent.glob("*.tmp"))

    conn = sqlite3.connect(dest)
    try:
        assert conn.execute("PRAGMA quick_check").fetchone() == ("ok",)
    finally:
        conn.close()


def test_explicit_backup_rejects_symlink_source(source_db, tmp_path):
    link = tmp_path / "linked.db"
    link.symlink_to(source_db)

    with pytest.raises(ValueError, match="symlink"):
        backup.backup_database(link)


def test_explicit_backup_rejects_symlink_destination(source_db, tmp_path):
    real_directory = tmp_path / "real-backups"
    real_directory.mkdir()
    linked_directory = tmp_path / "linked-backups"
    linked_directory.symlink_to(real_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="symlink"):
        backup.backup_database(source_db, directory=linked_directory)


def test_explicit_backup_supports_safe_custom_prefix(source_db, tmp_path):
    dest = backup.backup_database(
        source_db,
        directory=tmp_path / "maintenance-backups",
        prefix="gpumon_backfill",
    )

    assert dest.name.startswith("gpumon_backfill_")
    assert stat.S_IMODE(dest.stat().st_mode) == 0o600
    assert _read_values(dest) == ["first", "second"]


def test_quick_check_runs_on_temp_file_before_publish(source_db, monkeypatch):
    checked = []
    real_check = backup._quick_check

    def observe(path):
        checked.append(path)
        assert path.name.startswith(".") and path.name.endswith(".db.tmp")
        assert not any(path.parent.glob("gpumon_*.db"))
        real_check(path)

    monkeypatch.setattr(backup, "_quick_check", observe)
    dest = backup.backup_now()
    assert checked and dest.exists()


def test_failed_check_removes_temp_and_does_not_publish(source_db, monkeypatch):
    def fail_check(_path):
        raise sqlite3.DatabaseError("simulated check failure")

    monkeypatch.setattr(backup, "_quick_check", fail_check)
    with pytest.raises(sqlite3.DatabaseError, match="simulated"):
        backup.backup_now()

    directory = source_db.parent / "backups"
    assert not list(directory.glob("gpumon_*.db"))
    assert not list(directory.glob("*.tmp"))
    assert list(directory.iterdir()) == [], "a failed backup leaves no temporary or sidecar file"


def test_backup_failure_never_prunes_existing_completed_files(source_db, monkeypatch):
    directory = backup.backup_dir()
    old = directory / "gpumon_20000101_000000.db"
    old.write_bytes(b"previous-good-backup")

    def fail_check(_path):
        raise sqlite3.DatabaseError("simulated check failure")

    monkeypatch.setattr(backup, "_quick_check", fail_check)
    with pytest.raises(sqlite3.DatabaseError):
        backup.backup_and_prune(keep=1)
    assert old.read_bytes() == b"previous-good-backup"


def test_successful_backup_prunes_only_completed_db_files(source_db):
    directory = backup.backup_dir()
    oldest = directory / "gpumon_20000101_000000.db"
    newest = directory / "gpumon_20000102_000000.db"
    ignored_tmp = directory / ".gpumon_interrupted.db.tmp"
    oldest.write_bytes(b"oldest")
    newest.write_bytes(b"newest")
    ignored_tmp.write_bytes(b"partial")

    created, deleted = backup.backup_and_prune(keep=2)

    assert created.exists()
    assert deleted == [oldest]
    assert newest.exists()
    assert ignored_tmp.exists()
    assert backup.list_backups() == [created, newest]


def test_prune_rejects_delete_everything_value(source_db):
    completed = backup.backup_now()
    with pytest.raises(ValueError, match="1..1000"):
        backup.prune_old_backups(keep=0)
    assert completed.exists()


def test_disabled_setting_skips_only_scheduled_cli(monkeypatch, capsys):
    from gpumon import config
    from gpumon.cli import _cmd_backup

    monkeypatch.setattr(
        config,
        "load_settings",
        lambda: SimpleNamespace(backup=SimpleNamespace(enabled=False)),
    )

    def must_not_run():
        raise AssertionError("scheduled backup should have been skipped")

    monkeypatch.setattr(backup, "backup_and_prune", must_not_run)
    assert _cmd_backup(SimpleNamespace(scheduled=True)) == 0
    assert "跳过" in capsys.readouterr().out


def test_published_backup_leaves_no_temporary_files_behind(source_db):
    """A WAL-mode copy gets -wal/-shm next to its temporary name during the check."""
    first = backup.backup_now()
    second = backup.backup_now()
    assert sorted(p.name for p in first.parent.iterdir()) == sorted([first.name, second.name])
    assert _read_values(second) == ["first", "second"]


def test_copy_with_unmerged_wal_content_is_not_published(source_db, monkeypatch):
    real_check = backup._quick_check

    def leave_frames(path):
        real_check(path)
        path.with_name(path.name + "-wal").write_bytes(b"frames that never reached the main file")

    monkeypatch.setattr(backup, "_quick_check", leave_frames)
    with pytest.raises(sqlite3.DatabaseError, match="WAL"):
        backup.backup_now()
    assert list((source_db.parent / "backups").iterdir()) == []


def _needed(source, wal_bytes=0):
    size = source.stat().st_size + wal_bytes
    return size + max(256 * 1024 ** 2, size // 5)


def _pretend_free(monkeypatch, free):
    real = backup.shutil.disk_usage
    monkeypatch.setattr(backup.shutil, "disk_usage", lambda path: real(path)._replace(free=free))


def test_backup_is_refused_before_writing_when_the_copy_cannot_fit(source_db, monkeypatch):
    directory = backup.backup_dir()
    old = directory / "gpumon_20000101_000000.db"
    old.write_bytes(b"previous-good-backup")

    _pretend_free(monkeypatch, _needed(source_db) - 1)
    with pytest.raises(OSError) as refused:
        backup.backup_and_prune(keep=1)
    assert refused.value.errno == errno.ENOSPC
    assert "未写入备份" in str(refused.value)
    assert [p.name for p in directory.iterdir()] == [old.name], "nothing written, nothing pruned"

    _pretend_free(monkeypatch, _needed(source_db))
    created, deleted = backup.backup_and_prune(keep=1)
    assert created.exists() and deleted == [old]


def test_space_check_counts_the_live_wal(source_db, monkeypatch):
    writer = sqlite3.connect(source_db)
    try:
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO samples(value) VALUES (?)", ("x" * 200_000,))
        writer.commit()
        wal_bytes = source_db.with_name(source_db.name + "-wal").stat().st_size
        assert wal_bytes > 100_000
        _pretend_free(monkeypatch, _needed(source_db, wal_bytes) - 1)
        with pytest.raises(OSError) as refused:
            backup.backup_now()
        assert refused.value.errno == errno.ENOSPC
        assert _needed(source_db) < _needed(source_db, wal_bytes) - 1, "enough if the WAL were ignored"
        _pretend_free(monkeypatch, _needed(source_db, wal_bytes))
        assert backup.backup_now().exists()
    finally:
        writer.close()


def test_large_database_needs_a_fifth_of_its_size_as_headroom(source_db, monkeypatch):
    with source_db.open("r+b") as handle:
        handle.truncate(2 * 1024 ** 3)  # sparse: only the reported size matters here
    size = source_db.stat().st_size
    _pretend_free(monkeypatch, size + size // 5 - 1)
    with pytest.raises(OSError) as refused:
        backup._require_space(source_db, backup.backup_dir())
    assert refused.value.errno == errno.ENOSPC
    _pretend_free(monkeypatch, size + size // 5)
    backup._require_space(source_db, backup.backup_dir())


def test_backup_sweeps_only_its_own_abandoned_files(source_db, tmp_path):
    directory = backup.backup_dir()
    day = 24 * 3600

    def make(name, age=0):
        path = directory / name
        path.write_bytes(b"x")
        if age:
            os.utime(path, (time.time() - age, time.time() - age))
        return path

    kept_backup = make("gpumon_20261030_040002_283766.db")
    removed = [
        make(".gpumon_20261029_040001_649606.db.tmp-journal"),   # failed copy: temporary file gone
        make(".pre_release_20261015_180316_480486.db.tmp-shm"),
        make(".pre_release_20261015_180316_480486.db.tmp-wal"),
        make("gpumon_20260811_013301_854407.db-wal"),            # backup itself pruned long ago
        make(".gpumon_20261101_040000_992863.db.tmp", age=2 * day),  # interrupted copy
        make(".gpumon_20261101_040000_992863.db.tmp-journal", age=2 * day),
    ]
    kept = [
        kept_backup,
        make("gpumon_20261030_040002_283766.db-shm"),            # its backup still exists
        make(".gpumon_20261113_040001_318771.db.tmp"),           # may be a copy in progress
        make(".gpumon_20261113_040001_318771.db.tmp-journal"),
        make(".gpumon_interrupted.db.tmp", age=2 * day),         # not a name this module makes
        make("gpumon_20000101_000000.db-wal"),
        make("notes.txt", age=2 * day),
        make("gpumon_20261030_040002_283766.db.tmp", age=2 * day),
    ]
    outside = tmp_path / "outside.db-wal"
    outside.write_bytes(b"x")
    link = directory / "gpumon_20260812_001330_555875.db-wal"
    link.symlink_to(outside)
    folder = directory / ".gpumon_20260813_040002_502099.db.tmp-shm"
    folder.mkdir()

    created = backup.backup_now()

    assert not any(path.exists() for path in removed)
    assert all(path.exists() for path in kept)
    assert link.is_symlink() and outside.exists() and folder.is_dir()
    assert created.exists()


def test_pruned_backup_takes_its_sidecar_files_with_it(source_db):
    directory = backup.backup_dir()
    old = directory / "gpumon_20000101_000000.db"
    old.write_bytes(b"oldest")
    sidecars = [directory / (old.name + suffix) for suffix in ("-wal", "-shm")]
    for sidecar in sidecars:
        sidecar.write_bytes(b"x")

    created, deleted = backup.backup_and_prune(keep=1)

    assert deleted == [old]
    assert not any(sidecar.exists() for sidecar in sidecars)
    assert backup.list_backups() == [created]


def test_sweep_failure_never_fails_a_completed_backup(source_db, monkeypatch):
    def broken(_directory):
        raise PermissionError("simulated")

    monkeypatch.setattr(backup.os, "scandir", broken)
    assert backup.backup_now().exists()
