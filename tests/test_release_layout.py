"""release/state 分离与 systemd 单一调度源的静态契约。"""
from pathlib import Path

from gpumon.config import CODE_ROOT

ROOT = Path(__file__).resolve().parents[1]


def test_code_root_owns_web_assets_independently_of_state_root():
    assert CODE_ROOT == ROOT
    assert (CODE_ROOT / "web" / "index.html").is_file()


def test_system_units_execute_through_current_release():
    unit_dir = ROOT / "deploy" / "systemd"
    for name in (
        "system-gpumon-collector.service",
        "system-gpumon-web.service",
        "gpumon-backup.service",
    ):
        text = (unit_dir / name).read_text(encoding="utf-8")
        assert "WorkingDirectory=__ROOT__/current" in text
        assert "Environment=GPUMON_ROOT=__ROOT__" in text
        assert "ExecStart=__ROOT__/current/.venv/bin/gpumon" in text
        assert "/opt/gpu-monitor" not in text


def test_backup_timer_has_exactly_one_schedule_and_no_eager_service_dependency():
    text = (ROOT / "deploy" / "systemd" / "gpumon-backup.timer").read_text(
        encoding="utf-8"
    )
    assert text.count("OnCalendar=") == 1
    assert "OnCalendar=*-*-* 04:00:00" in text
    assert "OnCalendar=daily" not in text
    assert "Requires=gpumon-backup.service" not in text


def test_system_web_unit_is_a_separate_read_only_sandbox():
    text = (
        ROOT / "deploy" / "systemd" / "system-gpumon-web.service"
    ).read_text(encoding="utf-8")

    assert "User=__WEB_USER__" in text
    assert "Group=__GROUP__" in text
    assert "User=__USER__" not in text
    for setting in (
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "PrivateDevices=true",
        "ProtectSystem=strict",
        "ProtectHome=true",
        "ReadOnlyPaths=__ROOT__",
        "IPAddressAllow=localhost",
        "IPAddressDeny=any",
    ):
        assert setting in text
    assert "ReadWritePaths=" not in text
