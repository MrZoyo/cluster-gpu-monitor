"""Local fault injection: no SSH connections or real GPUs."""
import asyncio
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from gpumon.collector import ssh, run
from gpumon.collector.parse import parse_probe
from gpumon.collector.policy import PollState
from gpumon.db.store import Store
from gpumon.models import CollectorSettings, HostSample, ProbeResult


@pytest.fixture
def rig(tmp_path, monkeypatch):
    cfg = CollectorSettings(gpu_timeout_s=1, gpu_slow_s=.5, gpu_recover_s=.1)
    monkeypatch.setattr(ssh, 'load_settings', lambda: SimpleNamespace(collector=cfg))
    binary = tmp_path / 'nvidia-smi'
    binary.write_text('''#!/usr/bin/env python3
import os, sys, time
with open(os.environ['CALLS'], 'a') as f: f.write(sys.argv[1] + '\\n')
metrics = sys.argv[1].startswith('--query-gpu=')
mode = os.environ.get('MODE', '')
if mode == 'hang' or (mode == 'apps-hang' and not metrics): time.sleep(10)
if mode == 'error': sys.exit(9)
print('0,GPU-test,Test GPU,80,20,1000,8000,40,120' if metrics else 'GPU-test,123,1000')
''')
    binary.chmod(0o755)
    calls = tmp_path / 'calls'
    env = {**os.environ, 'PATH': str(tmp_path) + ':' + os.environ['PATH'],
           'XDG_RUNTIME_DIR': str(tmp_path), 'CALLS': str(calls)}
    def execute(mode='', enabled=True):
        completed = subprocess.run(['bash'], input=ssh._build_script('nvidia', gpu_enabled=enabled),
            text=True, capture_output=True, timeout=8, env={**env, 'MODE': mode})
        assert completed.returncode == 0, completed.stderr
        return parse_probe('test', completed.stdout), completed.stdout
    return cfg, execute, calls, env


def test_remote_timeout_preserves_host_without_extra_query(rig):
    _, execute, calls, _ = rig
    result, _ = execute('hang')
    assert result.host_reachable and result.host.ncpu
    assert result.gpu_status == 'timeout' and not result.ok
    assert result.gpus == [] and not result.apps_ok
    assert len(calls.read_text().splitlines()) == 1


def test_process_timeout_preserves_completed_gpu_metrics(rig):
    _, execute, calls, _ = rig
    result, _ = execute('apps-hang')
    assert result.host_reachable and result.ok
    assert result.gpus[0].util_gpu == 80
    assert result.gpu_status == 'timeout' and not result.apps_ok and not result.procs
    assert len(calls.read_text().splitlines()) == 2


def test_heartbeat_never_invokes_smi_and_normal_probe_uses_two_calls(rig):
    _, execute, calls, _ = rig
    heartbeat, _ = execute(enabled=False)
    assert heartbeat.host_reachable and heartbeat.gpu_status == 'skipped'
    assert not calls.exists()
    normal, _ = execute()
    assert normal.ok and normal.apps_ok
    assert len(calls.read_text().splitlines()) == 2


def test_driver_error_and_truncated_gpu_are_not_overload(rig):
    _, execute, _, _ = rig
    failure, _ = execute('error')
    assert failure.host_reachable and failure.gpu_status == 'error'
    _, raw = execute()
    partial = parse_probe('test', raw.split('##GPU_END')[0])
    assert partial.host_reachable and partial.gpu_status == 'unknown' and not partial.gpus


def test_remote_lock_prevents_overlapping_query(rig):
    _, execute, calls, env = rig
    import fcntl
    lock_dir = Path(env['XDG_RUNTIME_DIR']) / f'gpumon-{os.getuid()}'
    lock_dir.mkdir(mode=0o700)
    with (lock_dir / 'gpu-probe.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result, _ = execute()
    assert result.gpu_status == 'timeout' and result.host_reachable
    assert not calls.exists()


@pytest.mark.parametrize('recover_count', [2, 3])
def test_cooldown_and_configured_recoveries_survive_restart(recover_count):
    cfg = CollectorSettings(gpu_recover_count=recover_count)
    state = PollState(30)
    slow = ProbeResult(host_key='test', ok=True, gpu_status='slow', gpu_elapsed_s=17)
    state.finish(slow, cfg, 0, 17, 1017, True)
    assert state.due == 60 and state.interval == 60
    saved = {'gpu_poll_interval_s': 60, 'next_gpu_try_ts': slow.next_gpu_try_ts,
             'fast_successes': 0, 'gpu_status': 'slow'}
    state = PollState.restore(cfg, saved, 1030, 500)
    assert state.due == 530
    skip = ProbeResult(host_key='test', ok=False, host_reachable=True, gpu_status='skipped')
    state.finish(skip, cfg, 510, 511, 1041, False)
    assert state.due == 530 and state.fast == 0
    for i in range(recover_count):
        start = state.due
        good = ProbeResult(host_key='test', ok=True, gpu_status='ok', gpu_elapsed_s=8)
        state.finish(good, cfg, start, start+8, 1100+i*60, True)
        assert state.interval == (30 if i == recover_count - 1 else 60)
        assert good.gpu_status == ('ok' if i == recover_count - 1 else 'recovering')
    state.finish(slow, cfg, 800, 812, 1800, True)
    assert state.fast == 0 and state.interval == 60


@pytest.mark.parametrize('elapsed, expected', [(12, 'ok'), (15, 'slow'), (19, 'slow')])
def test_probe_uses_relaxed_defaults_with_bounded_timeout(monkeypatch, elapsed, expected):
    cfg = CollectorSettings()
    monkeypatch.setattr(ssh, 'load_settings', lambda: SimpleNamespace(collector=cfg))
    async def spawn(*args, **kwargs):
        assert 'ConnectTimeout=15' in args
        return SimpleNamespace(returncode=0)
    async def communicate(*args):
        return b'probe fixture', b''
    async def wait(task, timeout):
        assert timeout == 41  # 15s connection + 1s CPU + 20s GPU + 5s cleanup
        return await task
    monkeypatch.setattr(ssh.asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(ssh, '_communicate_limited', communicate)
    monkeypatch.setattr(ssh.asyncio, 'wait_for', wait)
    monkeypatch.setattr(ssh, 'parse_probe', lambda *args: ProbeResult(
        host_key='test', ok=True, gpu_status='ok', gpu_elapsed_s=elapsed))
    result = asyncio.run(ssh.probe('test', 'unused', 'nvidia'))
    assert result.gpu_status == expected


def make_store(tmp_path):
    store = Store(tmp_path / 'probe.db')
    store.init_schema()
    with store.write_conn() as conn:
        conn.execute("INSERT INTO cluster VALUES(1,'c','C',0)")
        conn.execute("INSERT INTO host(id,cluster_id,key,ssh_alias,display_name,gpu_count) VALUES(1,1,'test','alias','Test',1)")
    return store


def test_heartbeat_persists_and_stale_collector_is_not_offline(tmp_path):
    store = make_store(tmp_path)
    result = ProbeResult(host_key='test', ok=False, host_reachable=True, host=HostSample(ncpu=8),
        gpu_status='timeout', gpu_poll_interval_s=60, next_gpu_try_ts=1060, apps_ok=False)
    store.record_round(1000, [result])
    status = store.get_collector_status(now=1000)[0]
    assert status['online'] and status['health'] == 'overloaded'
    assert not store.get_collector_status(online_window_s=10, now=1011)[0]['online']
    assert store.get_snapshot()['hosts'][1]['ncpu'] == 8
    assert not store.get_snapshot()['gpus']
    failed = ProbeResult(host_key='test', ok=False, gpu_status='unknown', gpu_poll_interval_s=60)
    store.record_round(1121, [failed])
    assert store.get_collector_status(now=1121)[0]['health'] == 'offline'
    assert store.get_collector_status(now=1250)[0]['health'] == 'unknown'
    assert store.get_collector_status(now=900)[0]['health'] == 'unknown'


def test_fast_host_is_written_before_slow_host_completes(monkeypatch):
    cfg = CollectorSettings()
    monkeypatch.setattr(run, 'load_settings', lambda: SimpleNamespace(collector=cfg))
    monkeypatch.setattr(run, '_hosts', lambda _: [('fast','fast',None), ('slow','slow',None)])
    async def scenario():
        released = asyncio.Event()
        order = []
        async def fake_probe(key, *args, **kwargs):
            if key == 'slow': await asyncio.wait_for(released.wait(), 1)
            return ProbeResult(host_key=key, ok=True, gpu_status='ok', gpu_elapsed_s=0)
        class Writer:
            def get_collector_status(self): return []
            def record_round(self, ts, results):
                order.append(results[0].host_key)
                if order[-1] == 'fast': released.set()
        monkeypatch.setattr(run, 'probe', fake_probe)
        await run._probe_all(store=Writer())
        assert order == ['fast', 'slow']
    asyncio.run(scenario())


def test_transport_timeout_retains_host_without_claiming_gpu_timeout(monkeypatch, rig):
    _, execute, _, _ = rig
    _, raw = execute(enabled=False)
    host_raw = raw.split('##GPU_SKIPPED')[0] + '##GPU_BEGIN\n'
    real_spawn = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs):
        return await real_spawn('bash', '-c', 'cat >/dev/null; printf %s "$1"; exec sleep 30',
                                'probe', host_raw, **kwargs)
    real_wait = asyncio.wait_for
    async def quick_wait(task, timeout): return await real_wait(task, .15)
    monkeypatch.setattr(ssh.asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(ssh.asyncio, 'wait_for', quick_wait)
    result = asyncio.run(ssh.probe('test', 'unused', 'nvidia'))
    assert result.host_reachable and result.host_sample_ts
    assert result.gpu_status == 'unknown' and not result.ok


def test_running_scheduler_keeps_healthy_cadence_and_skips_gpu_during_cooldown(monkeypatch):
    import time
    cfg = CollectorSettings(poll_interval_s=1, gpu_backoff_s=3)
    monkeypatch.setattr(run, 'load_settings', lambda: SimpleNamespace(collector=cfg))
    monkeypatch.setattr(run, '_hosts', lambda _: [('fast','fast',None), ('slow','slow',None)])
    calls, active, writes = [], set(), []
    async def fake_probe(key, *args, gpu_enabled=True, **kwargs):
        assert key not in active
        active.add(key)
        calls.append((key, gpu_enabled, time.monotonic()))
        try:
            await asyncio.sleep(.02)
            status = 'timeout' if key == 'slow' and gpu_enabled else 'ok' if gpu_enabled else 'skipped'
            return ProbeResult(host_key=key, ok=status == 'ok', host_reachable=True,
                gpu_status=status, gpu_elapsed_s=20 if status == 'timeout' else 0)
        finally:
            active.remove(key)
    class Writer:
        def init_schema(self): pass
        def sync_topology(self): pass
        def get_collector_status(self): return []
        def record_round(self, ts, results):
            writes.append(results[0].host_key)
            if writes.count('fast') == 6: raise KeyboardInterrupt
    class NoRollup:
        def __init__(self, store): pass
        def roll_gpu_5m(self, ts): pass
        def roll_gpu_1h(self, ts): pass
        def roll_host_1h(self, ts): pass
        def cleanup(self, ts): pass
    monkeypatch.setattr(run, 'probe', fake_probe)
    monkeypatch.setattr(run, 'Store', Writer)
    monkeypatch.setattr(run, 'Rollup', NoRollup)
    assert run.run_forever() == 0
    fast = [t for k,g,t in calls if k == 'fast' and g]
    slow = [t for k,g,t in calls if k == 'slow' and g]
    assert len(fast) == 6 and len(slow) == 2
    assert slow[1] - slow[0] >= 3
    assert all(.95 <= b-a < 1.5 for a,b in zip(fast, fast[1:]))
    assert any(k == 'slow' and not g for k,g,_ in calls)
    assert not active


def test_invalid_gpu_metadata_does_not_discard_completed_host(rig):
    _, execute, _, _ = rig
    _, raw = execute()
    invalid = raw.split('##GPU_DONE')[0] + '##GPU_DONE\n0 nan\n##END\n'
    result = parse_probe('test', invalid)
    assert result.host_reachable and result.host.ncpu
    assert result.gpu_status == 'error' and not result.gpus
