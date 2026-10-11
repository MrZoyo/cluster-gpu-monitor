"""Immutable frontend bundles and atomic, service-independent activation (stdlib only)."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.request import urlopen

VERSION = re.compile(r"[0-9a-f]{64}\Z")
MAX_BYTES = 32 * 1024 * 1024


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def files(root: Path) -> dict[str, str]:
    result = {}
    size = 0
    for path in sorted(root.rglob("*")):
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise ValueError("Symlinks are not allowed in frontend/runtime payloads")
        if path.is_file():
            size += path.stat().st_size
            if size > MAX_BYTES or len(result) >= 2048:
                raise ValueError("Payload exceeds bounded size/file limit")
            result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return result


def fingerprint(source: Path) -> str:
    runtime = {}
    for name in ("src", "deploy"):
        runtime[name] = files(source / name)
    for name in ("pyproject.toml", "uv.lock"):
        runtime[name] = digest((source / name).read_bytes())
    return digest(json.dumps(runtime, sort_keys=True).encode())


def manifest(source: Path) -> dict:
    payload = {"protocol": 1, "backend": fingerprint(source), "files": files(source / "web")}
    payload["version"] = digest(json.dumps(payload, sort_keys=True).encode())
    return payload


def validate(bundle: Path, backend: str) -> dict:
    info = json.loads((bundle / "manifest.json").read_text())
    version = info.pop("version")
    if info.get("protocol") != 1 or info.get("backend") != backend:
        raise ValueError("Frontend requires a different backend; use a full release")
    if not VERSION.fullmatch(version) or digest(json.dumps(info, sort_keys=True).encode()) != version:
        raise ValueError("Invalid manifest version")
    if info["files"] != files(bundle / "web") or "index.html" not in info["files"]:
        raise ValueError("Incomplete or modified frontend bundle")
    info["version"] = version
    return info


def build(source: Path, output: Path) -> dict:
    info = manifest(source)
    output.mkdir()  # Never overwrite an existing artifact.
    shutil.copytree(source / "web", output / "web", symlinks=True)
    (output / "manifest.json").write_text(json.dumps(info, sort_keys=True))
    validate(output, info["backend"])
    return info


def atomic_pointer(store: Path, name: str, version: str) -> None:
    temporary = store / f".{name}-{os.getpid()}"
    try:
        temporary.symlink_to(f"releases/{version}")
        temporary.replace(store / name)
    finally:
        temporary.unlink(missing_ok=True)


def pointer_version(store: Path) -> str | None:
    try:
        target = (store / "current").resolve(strict=True)
        return target.name if target.parent == (store / "releases").resolve() and VERSION.fullmatch(target.name) else None
    except OSError:
        return None


def install(bundle: Path, store: Path, backend: str) -> dict:
    info = validate(bundle, backend)
    releases = store / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / info["version"]
    if target.exists():
        validate(target, backend)
        return info
    with tempfile.TemporaryDirectory(prefix=".staging-", dir=releases) as temp:
        staged = Path(temp) / "bundle"
        shutil.copytree(bundle, staged, symlinks=True)
        validate(staged, backend)
        # Bundles contain public assets only; gpumon-web must be able to read them.
        for path in [staged, *staged.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        staged.rename(target)
    return info


def status(url: str) -> dict:
    with urlopen(url.rstrip("/") + "/api/frontend-release", timeout=5) as response:
        return json.load(response)


@contextmanager
def release_lock(store: Path):
    store.mkdir(parents=True, exist_ok=True)
    with (store / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def activate(source: Path, bundle: Path, store: Path, expected: str, url: str) -> dict:
    """Install, preflight through the running Web, switch, verify; roll back on error.

    No service operations, database access, package installation or old-version deletion.
    The same function activates an older retained bundle for rollback.
    """
    baseline = manifest(source)
    backend = baseline["backend"]
    with release_lock(store):
        before = status(url)
        if before != {"protocol": 1, "backend": backend, "version": expected}:
            raise ValueError("Running Web capability/backend/version changed; refusing activation")
        # Preserve the initial bundled assets, including for tabs opened before the first switch.
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "baseline"
            build(source, original)
            install(original, store, backend)
        candidate = install(bundle, store, backend)
        version = candidate["version"]
        with urlopen(url.rstrip("/") + f"/_frontend/{version}/index.html", timeout=5) as response:
            if response.headers.get("X-Gpumon-Frontend") != version:
                raise ValueError("Running Web cannot serve staged frontend from this store")
            response.read(MAX_BYTES + 1)
        old_pointer = pointer_version(store)
        try:
            atomic_pointer(store, "current", version)
            after = status(url)
            if after.get("version") != version or after.get("backend") != backend:
                raise ValueError("Frontend activation health check failed")
            with urlopen(url.rstrip("/") + "/", timeout=5) as response:
                if response.headers.get("X-Gpumon-Frontend") != version:
                    raise ValueError("Frontend entry point did not switch")
                response.read(MAX_BYTES + 1)
            atomic_pointer(store, "previous", expected)
        except BaseException:
            atomic_pointer(store, "current", old_pointer or baseline["version"])
            raise
        return after


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("build", "activate"))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--store", type=Path)
    parser.add_argument("--expected")
    parser.add_argument("--url", default="http://127.0.0.1:8848")
    args = parser.parse_args()
    if args.operation == "build":
        result = build(args.source, args.bundle)
    else:
        if not args.store or not args.expected or not VERSION.fullmatch(args.expected):
            parser.error("activate requires --store and a full --expected frontend version")
        result = activate(args.source, args.bundle, args.store, args.expected, args.url)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
