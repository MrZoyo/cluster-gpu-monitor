"""Optional integration against a real Caddy binary; uses loopback and fake data."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

import pytest

CADDY = os.environ.get("GPUMON_TEST_CADDY") or shutil.which("caddy")


@pytest.mark.skipif(not CADDY, reason="set GPUMON_TEST_CADDY to run real proxy integration")
@pytest.mark.parametrize("cloudflare_peer", [False, True])
def test_anonymous_path_and_canonical_forwarded_ip(tmp_path, cloudflare_peer):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({
                "ip": self.headers.get("X-Forwarded-For"),
                "temporary_header": self.headers.get("X-Gpumon-Client-IP"),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    snippet = (Path(__file__).parents[1] / "deploy/caddy/public-summary.caddy").read_text()
    snippet = snippet.replace("127.0.0.1:8848", f"127.0.0.1:{backend.server_port}")
    if cloudflare_peer:
        # Simulate a trusted edge connection, without spoofing an actual source IP.
        lines = snippet.splitlines()
        lines = ["        @gpumon_cloudflare remote_ip 127.0.0.1/32"
                 if line.strip().startswith("@gpumon_cloudflare remote_ip") else line
                 for line in lines]
        snippet = "\n".join(lines)
    hashed = subprocess.run(
        [CADDY, "hash-password", "--plaintext", "test-only-password"],
        check=True, text=True, capture_output=True, timeout=15,
    ).stdout.strip()
    config = tmp_path / "Caddyfile"
    config.write_text("{\n admin off\n auto_https off\n}\n" + snippet + f"""
http://127.0.0.1:{port} {{
    import gpumon_summary_access
    basicauth @gpumon_private {{
        test {hashed}
    }}
    import gpumon_summary_proxy
}}
""")
    env = {**os.environ, "XDG_DATA_HOME": str(tmp_path / "data"),
           "XDG_CONFIG_HOME": str(tmp_path / "config")}
    subprocess.run([CADDY, "validate", "--adapter", "caddyfile", "--config", str(config)],
                   check=True, capture_output=True, timeout=15, env=env)
    log = (tmp_path / "caddy.log").open("w+")
    process = subprocess.Popen(
        [CADDY, "run", "--adapter", "caddyfile", "--config", str(config)],
        stdout=log, stderr=log, env=env,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, method="GET", headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}" + path,
                                     method=method, headers=headers or {})
        try:
            response = opener.open(req, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.code, response.read()

    try:
        for _ in range(60):
            try:
                status, _ = request("/api/overview")
                break
            except urllib.error.URLError:
                if process.poll() is not None:
                    log.seek(0)
                    pytest.fail(log.read()[-4000:])
                time.sleep(0.05)
        else:
            pytest.fail("Caddy did not start")
        assert status == 401
        status, raw = request("/api/v1/gpu-summary", headers={
            "X-Forwarded-For": "198.51.100.99",
            "CF-Connecting-IP": "203.0.113.5",
            "X-Gpumon-Client-IP": "198.51.100.88",
        })
        assert status == 200
        assert json.loads(raw) == {
            "ip": "203.0.113.5" if cloudflare_peer else "127.0.0.1",
            "temporary_header": None,
        }
        assert request("/api/v1/gpu-summary", method="POST")[0] == 401
        assert request("/api/v1/gpu-summary/")[0] == 401
        assert request("/api/overview")[0] == 401
        auth = base64.b64encode(b"test:test-only-password").decode()
        assert request("/api/overview", headers={"Authorization": "Basic " + auth})[0] == 200
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log.close()
        backend.shutdown()
        backend.server_close()
        thread.join(timeout=2)
