"""Adaptive sampling preserves denominators and separates stale data from idle."""
import sqlite3
from types import SimpleNamespace

import pytest

from gpumon.api import routes, public_summary
from gpumon.db.store import Store
from gpumon.db.rollup import Rollup
from gpumon.models import GpuSample, HostSample, ProbeResult, ProcSample
from test_adaptive_probe import make_store


def observed(ts, interval=30, util=80):
    return ProbeResult(host_key='test', ok=True, host_reachable=True, host=HostSample(ncpu=8),
        gpus=[GpuSample(index=0, uuid='GPU-test', util_gpu=util)],
        procs=[ProcSample(gpu_uuid='GPU-test', pid=1, username='alice', mem_used_mib=100)],
        gpu_status='ok', gpu_elapsed_s=1, host_sample_ts=ts, gpu_sample_ts=ts,
        sample_interval_s=interval, gpu_poll_interval_s=interval, next_gpu_try_ts=ts+interval)


@pytest.fixture
def configured(monkeypatch):
    from gpumon.config import load_settings
    cfg = load_settings()
    inventory = SimpleNamespace(defaults=SimpleNamespace(gpu_count=1),
        clusters=[SimpleNamespace(key='c', status='active',
            hosts=[SimpleNamespace(key='test', status='active', gpu_count=1)])])
    monkeypatch.setattr('gpumon.db.store.load_inventory', lambda: inventory)
    monkeypatch.setattr('gpumon.db.store.load_settings', lambda: cfg)
    monkeypatch.setattr('gpumon.db.rollup.load_settings', lambda: cfg)
    return cfg


def test_weights_preserve_hours_mean_and_coverage_without_filling_failures(tmp_path, configured):
    store = make_store(tmp_path)
    base = 3600 * 500000
    ts = base
    for i in range(60):
        interval = 30 if i < 30 else 60
        ts += interval
        result = observed(ts, interval, 100 if i < 30 else 20)
        # Multiple PIDs on the same card must not double the sampling weight.
        result.procs.append(ProcSample(gpu_uuid='GPU-test', pid=2, username='alice', mem_used_mib=100))
        store.record_round(ts, [result])
    now = base + 7200
    Rollup(store).roll_all(now)
    assert store.write_conn().execute('SELECT SUM(seconds) FROM sample_weight').fetchone()[0] == 2700
    assert store.get_users_top('12h', now=now)[0]['gpu_hours'] == .8
    assert store.get_users_ranking('12h', now=now)['users'][0]['total'] == .8
    avg = store.get_avg('12h', 'gpu', 'util_gpu', now=now)[0]
    assert avg['avg'] == 46.7  # (100*900 + 20*1800) / 2700
    assert avg['coverage'] == round(2700 / (12*3600), 3)
    assert store.get_avg('72h', 'gpu', 'util_gpu', now=now)[0]['avg'] == 46.7
    assert store.get_series('gpu', 1, 'util_gpu', '72h', now=now)[0][1] == 46.7
    count = store.write_conn().execute('SELECT COUNT(*) FROM sample_gpu').fetchone()[0]
    store.record_round(ts+60, [ProbeResult(host_key='test', ok=False, host_reachable=True,
        gpu_status='timeout', gpu_poll_interval_s=60)])
    assert store.write_conn().execute('SELECT COUNT(*) FROM sample_gpu').fetchone()[0] == count
    assert store.write_conn().execute('SELECT COUNT(*) FROM sample_weight').fetchone()[0] == count


def test_recent_mean_uses_period_weights(tmp_path, configured):
    store = make_store(tmp_path)
    store.record_round(1000, [observed(1000, 30, 100)])
    store.record_round(1060, [observed(1060, 60, 20)])
    assert store.get_util_recent(now=1061)[1] == 46.7


def test_metadata_only_upgrade_preserves_old_samples_and_is_idempotent(tmp_path):
    path = tmp_path / 'legacy.db'
    conn = sqlite3.connect(path)
    schema = __import__('gpumon.db.store', fromlist=['SCHEMA_PATH']).SCHEMA_PATH.read_text()
    # Reconstruct the old rollup layout, without the additive column.
    conn.executescript('\n'.join(line for line in schema.splitlines() if not ('_weight_s REAL' in line or 'weight_s      REAL' in line)))
    conn.execute("INSERT INTO cluster VALUES(1,'c','C',0)")
    conn.execute("INSERT INTO host(id,cluster_id,key,ssh_alias,display_name,gpu_count) VALUES(1,1,'test','a','Test',1)")
    conn.execute("INSERT INTO gpu_card(id,host_id,gpu_index,uuid) VALUES(1,1,0,'GPU-test')")
    conn.execute('INSERT INTO sample_gpu(gpu_id,ts,util_gpu) VALUES(1,100,77)')
    conn.execute('INSERT INTO rollup_gpu_5m(gpu_id,bucket_ts,n,util_gpu_avg) VALUES(1,0,1,77)')
    conn.commit(); conn.close()
    store = Store(path)
    store.init_schema(); store.init_schema()
    conn = store.write_conn()
    assert tuple(conn.execute('SELECT ts,util_gpu FROM sample_gpu').fetchone()) == (100,77)
    assert tuple(conn.execute('SELECT n,util_gpu_avg,weight_s FROM rollup_gpu_5m').fetchone()) == (1,77,None)


def test_overview_summary_and_users_agree_when_gpu_fails(tmp_path, monkeypatch, configured):
    store = make_store(tmp_path)
    store.record_round(1000, [observed(1000, 30, 0)])
    store.record_round(1030, [ProbeResult(host_key='test', ok=False, host_reachable=True,
        host=HostSample(ncpu=8), gpu_status='timeout', gpu_poll_interval_s=60, apps_ok=False)])
    monkeypatch.setattr(routes, 'get_store', lambda: store)
    monkeypatch.setattr(routes.time, 'time', lambda: 1031)
    meta = {'test': {'status':'active', 'note':None, 'note_i18n':None, 'meta':{}}}
    topology = lambda: (store.get_topology(), [], {'c':{'status':'active'}}, meta)
    monkeypatch.setattr(routes, '_topology_with_inventory_placeholders', topology)
    monkeypatch.setattr(routes, '_get_avg', lambda *a, **kw: [])
    data = routes.overview('12h')
    host = data['clusters'][0]['hosts'][0]
    assert host['online'] and host['health'] == 'overloaded'
    assert host['system']['ncpu'] == 8
    assert host['gpus'][0]['now'] is None
    assert host['gpus'][0]['last_sample']['ts'] == 1000
    assert host['gpus'][0]['last_sample']['util_recent'] == 0
    assert host['gpus'][0]['users'] == [] and not host['gpus'][0]['process_data_available']
    assert data['summary']['cards_idle'] == 0
    assert data['summary']['cards_unknown'] == 1
    assert data['summary']['hosts_overloaded'] == 1
    assert store.get_users_current(now=1031) == []
    monkeypatch.setattr(public_summary, 'get_store', lambda: store)
    monkeypatch.setattr(public_summary, '_topology_with_inventory_placeholders', topology)
    snap = public_summary._load_snapshot(1031)
    public = public_summary._render(snap, 1031)['hosts'][0]
    assert public['online'] and public['health'] == 'overloaded' and public['util_pct'] == [None]
    expired = public_summary._render(snap, 1151)['hosts'][0]
    assert not expired['online'] and expired['health'] == 'unknown'


@pytest.mark.parametrize('age, heartbeat, expected', [
    (28, True, 80), (91, True, 80), (180, True, 80),
    (181, True, None), (121, False, None), (-1, True, None),
])
def test_previous_display_expires_without_promoting_old_metrics(
        tmp_path, monkeypatch, configured, age, heartbeat, expected):
    store = make_store(tmp_path)
    store.record_round(1000, [observed(1000)])
    now = 1000 + age
    store.record_round(now, [ProbeResult(host_key='test', ok=False,
        host_reachable=heartbeat, gpu_status='unknown', gpu_poll_interval_s=60, apps_ok=False)])
    monkeypatch.setattr(routes, 'get_store', lambda: store)
    monkeypatch.setattr(routes.time, 'time', lambda: now)
    monkeypatch.setattr(routes, '_topology_with_inventory_placeholders', lambda: (
        store.get_topology(), [], {'c': {'status': 'active'}}, {'test': {'status': 'active', 'note': None, 'note_i18n': None, 'meta': {}}}))
    monkeypatch.setattr(routes, '_get_avg', lambda *a, **kw: [])
    data = routes.overview('12h')
    gpu = data['clusters'][0]['hosts'][0]['gpus'][0]
    assert gpu['last_sample']['util_recent'] == expected
    assert gpu['now'] is None and gpu['util_recent'] is None
    assert gpu['users'] == [] and not gpu['process_data_available']
    assert data['summary']['cards_unknown'] == 1
    assert data['summary']['cards_idle'] == data['summary']['cards_busy'] == 0
    assert store.write_conn().execute('SELECT COUNT(*) FROM sample_gpu').fetchone()[0] == 1


def test_previous_display_does_not_resurrect_a_missing_card(tmp_path, monkeypatch, configured):
    store = make_store(tmp_path)
    store.record_round(1000, [observed(1000)])
    changed = observed(1030)
    changed.gpus[0].uuid = 'GPU-replacement'
    store.record_round(1030, [changed])
    monkeypatch.setattr(routes, 'get_store', lambda: store)
    monkeypatch.setattr(routes.time, 'time', lambda: 1031)
    monkeypatch.setattr(routes, '_topology_with_inventory_placeholders', lambda: (
        store.get_topology(), [], {'c': {'status': 'active'}}, {'test': {'status': 'active', 'note': None, 'note_i18n': None, 'meta': {}}}))
    monkeypatch.setattr(routes, '_get_avg', lambda *a, **kw: [])
    gpus = routes.overview('12h')['clusters'][0]['hosts'][0]['gpus']
    assert gpus[0]['now'] is None and gpus[0]['last_sample']['util_recent'] is None
    assert gpus[1]['now']['util_gpu'] == 80 and gpus[1]['last_sample'] is None


def test_missing_metric_keeps_its_own_denominator_across_rollups(tmp_path, configured):
    store = make_store(tmp_path)
    base = 3600 * 500000
    for ts, interval, util in [(base+30,30,100),(base+90,60,None),(base+390,60,20)]:
        store.record_round(ts, [observed(ts, interval, util)])
    Rollup(store).roll_all(base+7200)
    expected = (100*30 + 20*60) / 90
    for window in ('12h','72h'):
        row = store.get_avg(window,'gpu','util_gpu',now=base+7200)[0]
        assert row['avg'] == round(expected,1)
    assert store.write_conn().execute('SELECT SUM(n) FROM rollup_gpu_5m').fetchone()[0] == 3
