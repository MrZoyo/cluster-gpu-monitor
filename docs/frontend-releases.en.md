# Frontend releases without restarting Web

[简体中文](frontend-releases.md) | English

The Web process serves an immutable frontend selected by `GPUMON_ROOT/frontend/current`.
Each HTML response pins its scripts, stylesheets and icons to `/_frontend/<version>/...`.
Activation replaces a symlink atomically. Existing tabs retain access to their old assets.
API handlers, database connections and collector processes do not change.

This requires the new serving code to be running first. Upgrading an older backend is a
separate full release; the asset publisher refuses unsupported backends and never restarts
Web as a fallback. Changes to Python code, dependency files or deployment templates require
a full release too. Static exports and GitHub Pages still use the original HTML assets.

## Standard workflow

For changes confined to `web/`, use this asset-only path after local validation. Do not overwrite
files in the running release, restart Web or collectors, or run database migrations. A failed
compatibility check stops publication; it is not permission to fall back to a full release.
Record the source commit, before/after frontend versions, backend fingerprint, rollback bundle
and Web PID. Verify the rendered page and its versioned assets after activation. Documentation-only
changes do not require deployment. Keep source history and production deployment records distinct.

## Build and activate

Use immutable source checkouts and retain the generated bundle manifest with the source Git
commit. The manifest records SHA-256 hashes for all assets and a runtime fingerprint of
`src`, `deploy`, `pyproject.toml` and `uv.lock`. A bundle is limited to 32 MiB / 2048 files;
symlinks are rejected. Hashes detect incomplete or changed payloads; transport and access
control remain the operator's responsibility.

```sh
python3 src/gpumon/frontend_release.py build --source /path/to/candidate --bundle /path/to/new-bundle

# Get the currently running frontend version, then pass it as --expected.
curl --fail --max-time 5 http://127.0.0.1:8848/api/frontend-release
python3 /path/to/running-source/src/gpumon/frontend_release.py activate \
  --source /path/to/running-source --bundle /path/to/new-bundle \
  --store /path/to/state/frontend --expected <current-frontend-version> \
  --url http://127.0.0.1:8848
```

Run activation as the deployment account with write access to the frontend store. Web needs
read access only. The store must be exactly `<GPUMON_ROOT>/frontend`. Activation checks the
running backend and expected version, validates the complete payload, probes the staged
HTML through the running Web, switches the pointer, and verifies the entry point. A failed
post-switch check restores the old pointer. No database, virtual environment, service unit
or `current` code-release pointer is modified.

## Rollback and concurrency

Activate the bundle referenced by `frontend/previous`, passing the current frontend version
as `--expected`. This uses the same validation and no-restart path. The initial bundled
frontend is retained before the first switch. Do not delete retained bundles while old tabs
may still request them; automatic garbage collection is deliberately absent.

All deployment/rollback paths must hold the same nonblocking `frontend/.lock` advisory lock
while changing a release. If a transport connection is lost, read `/api/frontend-release`
before retrying: the pointer may already have changed. A full backend upgrade ignores a
frontend pointer with a different runtime fingerprint and serves its own bundled frontend.
Compatibility of tabs spanning a **backend** upgrade is outside the asset-only guarantee.

The local integration suite follows HTML-pinned JS/CSS URLs while performing three upgrades
and three rollbacks, checks the same server PID and health responses, and exercises rejected
and failed activations. It is local evidence, not a guarantee against unrelated production
network, proxy or backend failures.
