"""Demo 生成/静态导出不得覆盖或误导出真实文件。"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.append(str(SCRIPTS))

import export_static_demo  # noqa: E402
import gen_demo_db  # noqa: E402
from demo_safety import (  # noqa: E402
    DEMO_INVENTORY_MARKER,
    DemoSafetyError,
    REPO_ROOT,
    assert_safe_export_directory,
    demo_database_state,
    safe_child,
    static_output_is_marked,
)


@pytest.mark.parametrize("dangerous", [Path("/"), Path.home(), REPO_ROOT, REPO_ROOT / "web/js"])
def test_static_export_rejects_dangerous_output_directories(dangerous):
    with pytest.raises(DemoSafetyError):
        assert_safe_export_directory(dangerous)


def test_safe_child_rejects_output_escape(tmp_path):
    with pytest.raises(DemoSafetyError):
        safe_child(tmp_path, "../outside.json")
    assert safe_child(tmp_path, "api/inside.json").is_relative_to(tmp_path)


def test_generator_refuses_real_names_even_with_force(tmp_path):
    real_named_db = tmp_path / "gpumon.db"
    real_named_db.write_bytes(b"must stay")
    inventory = tmp_path / "inventory.demo.yaml"

    rc = gen_demo_db.main([
        "--db", str(real_named_db),
        "--inventory", str(inventory),
        "--days", "0",
        "--force",
        "--quiet",
    ])

    assert rc == 2
    assert real_named_db.read_bytes() == b"must stay"
    assert not inventory.exists()


def test_generator_refuses_to_overwrite_unmarked_files(tmp_path):
    db = tmp_path / "demo.db"
    inventory = tmp_path / "inventory.demo.yaml"
    db.write_bytes(b"not a demo database")
    inventory.write_text("not a demo inventory\n", encoding="utf-8")

    rc = gen_demo_db.main([
        "--db", str(db),
        "--inventory", str(inventory),
        "--days", "0",
        "--force",
        "--quiet",
    ])

    assert rc == 2
    assert db.read_bytes() == b"not a demo database"
    assert inventory.read_text(encoding="utf-8") == "not a demo inventory\n"


@pytest.mark.parametrize("with_pai", [False, True])
def test_generated_demo_is_marked_and_exportable(tmp_path, with_pai):
    db = tmp_path / "synthetic-demo.db"
    inventory = tmp_path / "inventory.demo.yaml"
    out = tmp_path / "static-demo"

    generated = gen_demo_db.main([
        "--db", str(db),
        "--inventory", str(inventory),
        "--days", "0",
        "--quiet",
    ])
    export_run = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "export_static_demo.py"),
            "--db", str(db),
            "--inventory", str(inventory),
            "--settings", str(REPO_ROOT / "config/settings.example.toml"),
            "--out", str(out),
            *(["--with-pai", "--pai-ranking-timezone", "Asia/Kolkata", "--pai-ranking-week-start", "friday", "--pai-ranking-reset-time", "08:45"] if with_pai else []),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert generated == 0
    assert demo_database_state(db) == "complete"
    assert inventory.read_text(encoding="utf-8").startswith(DEMO_INVENTORY_MARKER + "\n")
    assert export_run.returncode == 0, export_run.stderr
    assert static_output_is_marked(out)
    assert (out / "index.html").is_file()
    # PAI remains optional; only explicitly requested synthetic data is exported.
    if with_pai:
        pai = json.loads((out / "api/pai_overview.json").read_text())
        assert pai["synthetic"] is True and pai["workspace_id"] == "demo-workspace"
        assert len(pai["nodes"]) == 4 and len(pai["workloads"]) == 5
        assert any(w["oversold"] for w in pai["workloads"])
        assert any(w["scheduled"] is False for w in pai["workloads"])
        assert pai["summary"]["mapped_gpus"] == pai["summary"]["pool_scheduled_gpus"] == 20
        assert pai["summary"]["pool_compute_estimate"] is None
        assert (out / "js/pai-estimate.js").is_file()
        assert (out / "api/pai_series.demo-dsw-vision.json").is_file()
        assert (out / "api/pai_ranking.24h.json").is_file()
        week = json.loads((out / "api/pai_ranking.week.json").read_text())
        assert (week["timezone"], week["week_start"], week["reset_time"]) == ("Asia/Kolkata", "friday", "08:45")
        assert week["since"] % 3600 == 15 * 60
        assert week["boundary_estimate"] is True
        assert 'case "pai/status"' in (out / "js/static-demo.js").read_text()
    else:
        assert not list((out / "api").glob("pai*"))
        assert "pai/" not in (out / "js/static-demo.js").read_text()
    assert (out / "api/live.json").read_text(encoding="utf-8") == '{"ok":true,"status":"alive"}'
    inventory_data = yaml.safe_load(inventory.read_text(encoding="utf-8"))
    assert inventory_data["badge_library"][0]["text"] == {
        "zh": "自建",
        "en": "Self-built",
    }
    meta = json.loads((out / "api/meta.json").read_text(encoding="utf-8"))
    group = meta["capacity_groups"][0]
    assert group["description"] == "自建机房。空调是去年双十一买的，夏天限功耗跑。"
    assert list(group["description_i18n"]) == ["zh", "en"]


def test_static_export_rejects_unmarked_database_without_deleting_output(tmp_path):
    db = tmp_path / "unmarked.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE harmless(value TEXT)")
    inventory = tmp_path / "inventory.demo.yaml"
    inventory.write_text(DEMO_INVENTORY_MARKER + "\nversion: 1\nclusters: []\n", encoding="utf-8")
    out = tmp_path / "existing-output"
    out.mkdir()
    sentinel = out / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")

    rc = export_static_demo.main([
        "--db", str(db),
        "--inventory", str(inventory),
        "--settings", str(REPO_ROOT / "config/settings.example.toml"),
        "--out", str(out),
        "--force",
    ])

    assert rc == 2
    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_demo_health_examples_use_export_clock_and_keep_stale_data_unknown(tmp_path):
    db = tmp_path / 'demo.db'
    inventory = tmp_path / 'inventory.demo.yaml'
    out = tmp_path / 'site'
    assert gen_demo_db.main(['--db',str(db),'--inventory',str(inventory),'--days','.03','--quiet']) == 0
    result = subprocess.run([sys.executable,str(SCRIPTS/'export_static_demo.py'),
        '--db',str(db),'--inventory',str(inventory),'--settings',str(REPO_ROOT/'config/settings.example.toml'),
        '--out',str(out)],capture_output=True,text=True,timeout=30)
    assert result.returncode == 0, result.stderr
    overview = json.loads((out/'api/overview.24h.json').read_text())
    hosts = [h for c in overview['clusters'] for h in c['hosts']]
    assert len(hosts) == 6
    assert [h['health'] for h in hosts] == ['online','overloaded','overloaded','overloaded','gpu_error','offline']
    assert hosts[1]['gpu_status'] == 'slow' and hosts[1]['online']
    assert all(g['now'] is not None for g in hosts[1]['gpus'])
    assert hosts[2]['gpu_status'] == 'timeout' and hosts[2]['online']
    assert all(g['now'] is None and g['last_sample']['ts'] <= overview['now']-180 for g in hosts[2]['gpus'])
    assert all(g['last_sample']['util_recent'] is None for g in hosts[2]['gpus'])
    assert hosts[3]['gpu_status'] == 'recovering'
    assert all(g['now'] is None and g['last_sample']['util_recent'] is not None for g in hosts[4]['gpus'])
    assert overview['summary']['cards_unknown'] == 24
    assert overview['summary']['hosts_overloaded'] == 3
    assert overview['summary']['hosts_online'] == 5
    assert overview['summary']['cards_idle'] + overview['summary']['cards_busy'] + overview['summary']['cards_unknown'] == 48
    assert all(h['last_heartbeat_ts'] <= overview['now'] for h in hosts)


def test_generator_needs_no_runtime_settings_in_clean_environment(tmp_path):
    runtime = tmp_path / 'no-runtime-config'
    result = subprocess.run([sys.executable, str(SCRIPTS / 'gen_demo_db.py'),
        '--db', str(tmp_path / 'demo.db'), '--inventory', str(tmp_path / 'inventory.demo.yaml'),
        '--days', '.01', '--quiet'], env={**os.environ, 'GPUMON_ROOT': str(runtime)},
        cwd=tmp_path, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not runtime.exists()
    assert demo_database_state(tmp_path / 'demo.db') == 'complete'


def test_pai_demo_uses_configured_reporting_rule_without_runtime_config(monkeypatch):
    from datetime import datetime
    from pai_demo import fixtures
    from gpumon.pai import config
    monkeypatch.setattr(config, "load_pai_settings", lambda: pytest.fail("demo must not read runtime PAI settings"))
    now = int(datetime.fromisoformat("2026-10-09T04:00:00+00:00").timestamp())
    data = fixtures(now, {"24h": 86400}, ranking_timezone="Asia/Kolkata", ranking_week_start="friday", ranking_reset_time="08:45")
    week = data["pai_ranking.week.json"]
    assert (week["timezone"], week["week_start"], week["reset_time"]) == ("Asia/Kolkata", "friday", "08:45")
    assert week["since"] == datetime.fromisoformat("2026-10-09T03:15:00+00:00").timestamp()
    assert data["pai_ranking.last_week.json"]["until"] == week["since"]
    assert week["synthetic"] is True


def test_pai_demo_previous_week_without_history_is_unknown():
    from datetime import datetime
    from pai_demo import fixtures
    now = int(datetime.fromisoformat("2026-10-10T04:00:00+00:00").timestamp())
    last = fixtures(now, {})["pai_ranking.last_week.json"]
    assert last["first_hour"] > last["until"]
    assert last["users"] == []
    assert all(f["gpu_hours"] is None and f["occupancy_pct"] is None for f in last["features"])


def test_pai_demo_has_confirmed_borrowing_parent_placement_and_missing_metrics():
    from pai_demo import fixtures

    now = 1792051200
    data = fixtures(now, {"24h": 86400})
    snapshot = data["pai_overview.json"]
    sources = {s["name"]: s for s in snapshot["sources"]}
    for node in snapshot["nodes"]:
        assert node["mapping_state"] == "ok"
        assert sources["pods:" + node["NodeName"]]["state"] == "ok"
        assert sources["pods-borrowed:" + node["NodeName"]]["state"] == "ok"
        assert all(len(card["assignments"]) <= 1 for card in node["cards"])

    borrowed = next(n for n in snapshot["nodes"] if n["borrowed_gpus"])
    assert borrowed["bound_quotas"] == ["demo-root", "demo-dev"]
    assert borrowed["RequestGPU"] == 0
    assert borrowed["borrowed_gpus"] == 8
    assert [c["index"] for c in borrowed["cards"]] == list(range(8))
    assert all(c["assignments"][0]["borrowed"] is True
               and c["assignments"][0]["owner_id"] == "demo-carol"
               and c["compute"]["fresh"] for c in borrowed["cards"])
    assert snapshot["summary"]["mapped_gpus"] == 20  # Both Pod views must not double-count.

    debug = next(w for w in snapshot["workloads"] if w["WorkloadId"] == "demo-dsw-debug")
    assert debug["QuotaId"] == "demo-root" and len(debug["cards"]) == 2
    assert not [m for m in debug["metrics"] if m["metric"] == "compute"]
    assert sources["metric:demo-dsw-debug:compute"]["state"] == "no_data"
    assert snapshot["summary"]["pool_compute_estimate"] is None
    assert snapshot["summary"]["task_measured_gpus"] == 18
    assert snapshot["summary"]["cluster_unallocated_gpus"] == 12
    training = next(q for q in snapshot["quotas"] if q["quota_id"] == "demo-train")
    assert training["oversold_enabled"] is False and training["ancestors_allocated_gpu"] == 2
    assert any(n["NodeStatus"] == "SchedulingDisabled" for n in snapshot["nodes"])

    rank = data["pai_ranking.24h.json"]
    for user in rank["users"]:
        assert sum(q["gpu_hours"] + q["oversold_gpu_hours"] for q in user["quotas"]) == user["gpu_hours"]
    assert sum(f["gpu_hours"] for f in rank["features"]) == rank["totals"]["gpu_hours"]
    assert sum(f["borrowed_gpu_hours"] for f in rank["features"]) == rank["totals"]["borrowed_gpu_hours"]
    assert sum(f["root_attributed_gpu_hours"] for f in rank["features"]) == rank["root_quota"]["gpu_hours"]
    assert rank["root_quota"]["root_attributed_gpu_hours"] == rank["root_quota"]["gpu_hours"]
    assert rank["root_quota"]["compute_mean"] == 1
    assert rank["root_quota"]["effective_gpu_hours"] == pytest.approx(2 * 24 * .01)
    assert sum(f["effective_gpu_hours"] for f in rank["features"]) == pytest.approx(rank["totals"]["effective_gpu_hours"])
    assert rank["quota_coverage_basis"] == "window_excluding_known_absence"
    assert all(f["expected_quota_hours"] == 24 and f["absent_quota_hours"] == 0
               for f in [*rank["features"], rank["root_quota"]])
    # Earlier fully observed history is independent of the missing current metrics.
    assert rank["cluster"]["physical_metric_coverage_pct"] == 100
    assert rank["cluster"]["known_gpu_hours"] == rank["cluster"]["capacity_gpu_hours"]
    assert rank["cluster"]["task_effective_gpu_hours"] == rank["totals"]["effective_gpu_hours"]
    assert rank["cluster"]["physical_utilization_pct"] == rank["cluster"]["task_utilization_estimate_pct"]
