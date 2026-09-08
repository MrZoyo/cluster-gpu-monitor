from concurrent.futures import ThreadPoolExecutor
import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from gpumon.api.app import create_app
from gpumon.api import public_summary as summary
from gpumon.db.store import Store


class Clock:
    value = 1000.0

    def __call__(self):
        return self.value


def snapshot(now):
    return {
        "as_of": now, "poll_interval_s": 30, "sample_max_age_s": 120,
        "hosts": [{
            "name": "Node A", "active": True, "last_ok_ts": now - 30,
            "gpus": [
                {"index": 0, "model": "GPU", "util_recent_pct": 0.0, "sampled_at": now - 30},
                {"index": 1, "model": "GPU", "util_recent_pct": 80.0, "sampled_at": now - 30},
            ],
        }],
    }


def make_service(loader=None):
    clock = Clock()
    calls = []

    def load(now):
        calls.append(now)
        return (loader or snapshot)(now)

    service = summary.SummaryService(loader=load, clock=clock, wall_clock=clock)
    return service, clock, calls


def body(response):
    return json.loads(response.body)


def test_rate_limit_exact_boundary_and_rejected_requests_do_not_extend_it():
    service, clock, calls = make_service()
    assert service.get("client-a").status_code == 200
    for now, retry in [(1000, "10"), (1009.2, "1")]:
        clock.value = now
        with pytest.raises(HTTPException) as error:
            service.get("client-a")
        assert error.value.status_code == 429
        assert error.value.headers["Retry-After"] == retry
    clock.value = 1010
    assert service.get("client-a").status_code == 200
    assert calls == [1000]


def test_cache_shared_between_clients_and_refreshed_at_thirty_seconds():
    service, clock, calls = make_service()
    first = body(service.get("a"))
    clock.value = 1029
    second = body(service.get("b"))
    assert first["as_of"] == second["as_of"] == 1000
    assert second["server_time"] == 1029
    clock.value = 1030
    assert body(service.get("c"))["as_of"] == 1030
    assert calls == [1000, 1030]


def test_freshness_expires_even_before_cached_snapshot_is_refreshed():
    def near_expiry(now):
        data = snapshot(now)
        data["hosts"][0]["gpus"][1]["sampled_at"] = now - 115
        data["hosts"][0]["last_ok_ts"] = now - 110
        return data

    service, clock, calls = make_service(near_expiry)
    assert body(service.get("a"))["hosts"][0]["gpus"][1]["util_recent_pct"] == 80
    clock.value = 1006
    host = body(service.get("b"))["hosts"][0]
    assert host["online"] is True
    assert host["gpus"][0]["util_recent_pct"] == 0
    assert host["gpus"][1]["util_recent_pct"] is None
    clock.value = 1011
    host = body(service.get("c"))["hosts"][0]
    assert host["online"] is False
    assert all(g["util_recent_pct"] is None for g in host["gpus"])
    assert calls == [1000]


def test_failed_refresh_does_not_consume_limit_or_serve_expired_cache():
    attempts = []

    def load(now):
        attempts.append(now)
        if len(attempts) in (1, 3):
            raise RuntimeError("private database path and password")
        return snapshot(now)

    service, clock, _ = make_service(load)
    with pytest.raises(HTTPException) as error:
        service.get("a")
    assert error.value.status_code == 503
    assert "private" not in str(error.value.detail)
    assert service.get("a").status_code == 200
    clock.value = 1030
    with pytest.raises(HTTPException) as error:
        service.get("b")
    assert error.value.status_code == 503
    assert body(service.get("b"))["as_of"] == 1030


def test_limiter_capacity_does_not_evict_live_clients(monkeypatch):
    monkeypatch.setattr(summary, "MAX_CLIENTS", 2)
    service, clock, _ = make_service()
    service.get("a")
    service.get("b")
    with pytest.raises(HTTPException) as error:
        service.get("c")
    assert error.value.status_code == 503
    with pytest.raises(HTTPException) as error:
        service.get("a")
    assert error.value.status_code == 429
    clock.value = 1010
    assert service.get("c").status_code == 200


def test_concurrent_requests_refresh_once_and_allow_same_ip_once():
    entered = threading.Event()
    release = threading.Event()

    def load(now):
        entered.set()
        assert release.wait(0.8)
        return snapshot(now)

    service, _, calls = make_service(load)
    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(service.get, "a")
        assert entered.wait(1)
        second = pool.submit(service.get, "a")
        third = pool.submit(service.get, "b")
        release.set()
        assert first.result().status_code == 200
        with pytest.raises(HTTPException) as error:
            second.result()
        assert error.value.status_code == 429
        assert third.result().status_code == 200
    assert calls == [1000]


def test_http_contract_and_client_cannot_choose_its_ip_with_headers():
    app = create_app()
    service, _, _ = make_service()
    app.state.gpu_summary = service
    client = TestClient(app, client=("198.51.100.1", 12000))
    response = client.get(summary.PATH)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["hosts"][0]["gpus"][1]["util_recent_pct"] == 80
    spoof = client.get(summary.PATH, headers={
        "X-Forwarded-For": "198.51.100.2",
        "CF-Connecting-IP": "198.51.100.3",
        "X-Gpumon-Client-IP": "198.51.100.4",
    })
    assert spoof.status_code == 429
    assert client.get(summary.PATH + "?refresh=true").status_code == 400
    assert client.post(summary.PATH).status_code == 405
    assert TestClient(app, client=("198.51.100.2", 12000)).get(summary.PATH).status_code == 200
    assert client.get("/openapi.json").status_code == 404


def test_only_loopback_proxy_can_supply_forwarded_ip_and_ipv4_aliases_share_limit():
    app = create_app()
    app.state.gpu_summary, _, _ = make_service()
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts=["127.0.0.1", "::1"])
    direct = TestClient(wrapped, client=("198.51.100.1", 12000))
    assert direct.get(summary.PATH, headers={"X-Forwarded-For": "198.51.100.99"}).status_code == 200
    assert direct.get(summary.PATH, headers={"X-Forwarded-For": "198.51.100.98"}).status_code == 429
    proxy = TestClient(wrapped, client=("127.0.0.1", 12000))
    assert proxy.get(summary.PATH, headers={"X-Forwarded-For": "198.51.100.2"}).status_code == 200
    assert proxy.get(summary.PATH, headers={"X-Forwarded-For": "::ffff:198.51.100.2"}).status_code == 429


def test_database_summary_matches_ui_smoothing_and_exposes_only_allowlisted_fields(tmp_path, monkeypatch):
    store = Store(path=tmp_path / "summary.db")
    store.init_schema()
    conn = store.write_conn()
    with conn:
        conn.execute("INSERT INTO cluster(id,key,name) VALUES(1,'c','Cluster')")
        conn.execute("INSERT INTO host(id,cluster_id,key,ssh_alias,display_name,gpu_count) "
                     "VALUES(1,1,'h','private-alias','Node A',4)")
        for gid in range(1, 4):
            conn.execute("INSERT INTO gpu_card(id,host_id,gpu_index,uuid,name) VALUES(?,1,?,?,?)",
                         (gid, gid - 1, f"private-uuid-{gid}", "GPU"))
        for ts, util in [(850, 100), (910, 3), (940, 5), (970, 0)]:
            conn.execute("INSERT INTO sample_gpu(gpu_id,ts,util_gpu) VALUES(1,?,?)", (ts, util))
        for ts, util in [(910, 80), (940, 100), (970, 60)]:
            conn.execute("INSERT INTO sample_gpu(gpu_id,ts,util_gpu) VALUES(2,?,?)", (ts, util))
        conn.execute("INSERT INTO sample_gpu(gpu_id,ts,util_gpu) VALUES(3,800,90)")
        conn.execute("INSERT INTO sample_proc(gpu_id,ts,pid,username,comm,mem_used_mib) "
                     "VALUES(1,970,42,'private-user','private-command',10000)")
    settings = SimpleNamespace(
        collector=SimpleNamespace(poll_interval_s=30),
        web=SimpleNamespace(max_query_concurrency=4, query_queue_timeout_s=1),
    )
    monkeypatch.setattr(summary, "load_settings", lambda: settings)
    monkeypatch.setattr(summary, "current_sample_max_age_s", lambda: 120)
    monkeypatch.setattr("gpumon.api.query_control.load_settings", lambda: settings)
    monkeypatch.setattr(summary, "get_store", lambda: store)
    topology = store.get_topology()
    topology[0]["hosts"][0]["meta"] = {"secret": "private-meta"}
    monkeypatch.setattr(summary, "_topology_with_inventory_placeholders",
                        lambda: (topology, [], {"c": {"status": "active"}}, {"h": {"status": "active"}}))
    monkeypatch.setattr(store, "get_collector_status",
                        lambda **_: [{"key": "h", "last_ok_ts": 970, "last_error": "private-error"}])
    # Public summary must not query current processes or historical rollups.
    monkeypatch.setattr(store, "get_snapshot", lambda: pytest.fail("process snapshot queried"))
    monkeypatch.setattr(store, "get_avg", lambda *a, **k: pytest.fail("historical rollup queried"))
    data = summary._render(summary._load_snapshot(1000), 1000)
    assert [g["util_recent_pct"] for g in data["hosts"][0]["gpus"]] == [0, 80, None, None]
    assert [g["sampled_at"] for g in data["hosts"][0]["gpus"]] == [970, 970, 800, None]
    assert "private" not in json.dumps(data)
    assert set(data["hosts"][0]) == {"name", "online", "gpus"}
    assert set(data["hosts"][0]["gpus"][0]) == {"index", "model", "util_recent_pct", "sampled_at"}
    conn.close()
