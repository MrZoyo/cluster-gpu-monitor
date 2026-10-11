"""Exercise real HTTP traffic across activation, rollback and rejected releases."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import socket
import threading
import time
from urllib.request import urlopen

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.testclient import TestClient
import uvicorn

from gpumon.api.frontend import FrontendFiles
from gpumon import frontend_release as release


@pytest.fixture
def source(tmp_path):
    source = tmp_path / "source"
    (source / "web/js").mkdir(parents=True)
    (source / "web/css").mkdir()
    (source / "src").mkdir()
    (source / "deploy").mkdir()
    (source / "src/main.py").write_text("backend = 1")
    (source / "pyproject.toml").write_text("version = '1'")
    (source / "uv.lock").write_text("version = 1")
    write_web(source, "old")
    return source


def write_web(source, label):
    (source / "web/index.html").write_text(
        f'<title>{label}</title><script src="/js/app.js"></script><link href="/css/style.css" rel="stylesheet">')
    (source / "web/js/app.js").write_text(f'const version = "{label}";')
    (source / "web/css/style.css").write_text(f'/* {label} */')


def make_app(source, store):
    frontend = FrontendFiles(source, store)
    async def status(request):
        return frontend.status()
    async def health(request):
        return JSONResponse({"pid": os.getpid()})
    return Starlette(routes=[Route('/api/frontend-release', status), Route('/api/health', health), Mount('/', app=frontend)])


@pytest.fixture
def live(source, tmp_path):
    store = tmp_path / "frontend"
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    url = f'http://127.0.0.1:{sock.getsockname()[1]}'
    server = uvicorn.Server(uvicorn.Config(make_app(source, store), log_level='error'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(.01)
    assert server.started
    yield url, store
    server.should_exit = True
    thread.join(5)
    sock.close()
    assert not thread.is_alive()


def get(url):
    with urlopen(url, timeout=3) as response:
        return response.read().decode(), response.headers


def candidate(source, tmp_path):
    import shutil
    changed = tmp_path / 'changed'
    shutil.copytree(source, changed)
    write_web(changed, 'new')
    bundle = tmp_path / 'bundle'
    return bundle, release.build(changed, bundle)


def test_live_switch_and_rollback_keep_requests_and_old_tabs_working(source, tmp_path, live):
    url, store = live
    old = release.status(url)
    bundle, new = candidate(source, tmp_path)
    old_html, _ = get(url)
    old_script = re.search(r'src="([^"]+)"', old_html)[1]
    old_pid = json.loads(get(url + '/api/health')[0])['pid']
    began = threading.Event()

    def reader():
        began.set()
        versions = set()
        for _ in range(100):
            html, headers = get(url)
            label = re.search(r'<title>(.*?)</title>', html)[1]
            # Follow the exact URL from each HTML, including when a switch intervenes.
            script = re.search(r'src="([^"]+)"', html)[1]
            css = re.search(r'href="([^"]+)"', html)[1]
            assert f'"{label}"' in get(url + script)[0]
            assert f'/* {label} */' == get(url + css)[0]
            assert json.loads(get(url + '/api/health')[0])['pid'] == old_pid
            versions.add(headers['X-Gpumon-Frontend'])
        return versions

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(reader)
        assert began.wait(2)
        for _ in range(3):
            assert release.activate(source, bundle, store, old['version'], url)['version'] == new['version']
            assert '"old"' in get(url + old_script)[0]
            assert release.activate(source, store / 'releases' / old['version'], store, new['version'], url)['version'] == old['version']
        assert future.result() == {old['version'], new['version']}
    assert release.status(url) == old


@pytest.mark.parametrize('failure', ['stale', 'backend', 'checksum', 'symlink'])
def test_rejected_bundle_keeps_current_page(source, tmp_path, live, failure):
    url, store = live
    before = release.status(url)
    bundle, _ = candidate(source, tmp_path)
    expected = before['version']
    if failure == 'stale':
        expected = '0' * 64
    elif failure == 'backend':
        metadata = json.loads((bundle / 'manifest.json').read_text())
        metadata['backend'] = '0' * 64
        (bundle / 'manifest.json').write_text(json.dumps(metadata))
    elif failure == 'checksum':
        (bundle / 'web/js/app.js').write_text('broken')
    else:
        (bundle / 'web/secret').symlink_to(source / 'pyproject.toml')
    with pytest.raises(ValueError):
        release.activate(source, bundle, store, expected, url)
    assert release.status(url) == before
    assert '<title>old</title>' in get(url)[0]


def test_failed_post_switch_probe_restores_previous_pointer(source, tmp_path, live, monkeypatch):
    url, store = live
    before = release.status(url)
    bundle, _ = candidate(source, tmp_path)
    original = release.status
    calls = 0
    def failure(url):
        nonlocal calls
        calls += 1
        return original(url) if calls == 1 else {}
    monkeypatch.setattr(release, 'status', failure)
    with pytest.raises(ValueError, match='health check'):
        release.activate(source, bundle, store, before['version'], url)
    assert original(url) == before


def test_routes_cache_traversal_and_backend_upgrade_fallback(source, tmp_path):
    bundle, metadata = candidate(source, tmp_path)
    store = tmp_path / 'frontend'
    release.install(bundle, store, release.fingerprint(source))
    release.atomic_pointer(store, 'current', metadata['version'])
    with TestClient(make_app(source, store)) as client:
        response = client.get('/')
        assert '<title>new</title>' in response.text
        assert response.headers['cache-control'] == 'no-cache'
        assert '/_frontend/' in response.text
        assert client.head('/').content == b''
        assert client.post('/').status_code == 405
        assert 'immutable' in client.get(f'/_frontend/{metadata["version"]}/js/app.js').headers['cache-control']
        assert client.get('/js/app.js').headers['cache-control'] == 'no-cache'
        assert client.get(f'/_frontend/{metadata["version"]}/%2e%2e/manifest.json').status_code == 404
        assert client.get('/_frontend/' + '0' * 64 + '/js/app.js').status_code == 404
    (source / 'src/main.py').write_text('backend = 2')
    with TestClient(make_app(source, store)) as client:
        assert '<title>old</title>' in client.get('/').text


def test_concurrent_activation_lock_fails_without_waiting(tmp_path):
    with release.release_lock(tmp_path):
        with pytest.raises(BlockingIOError):
            with release.release_lock(tmp_path):
                pytest.fail('second deploy entered the critical section')
