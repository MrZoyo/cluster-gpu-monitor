# Cluster GPU Monitor

[简体中文](README.md) | English

[![Tests](https://github.com/MrZoyo/cluster-gpu-monitor/actions/workflows/test.yml/badge.svg)](https://github.com/MrZoyo/cluster-gpu-monitor/actions/workflows/test.yml)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Monitor NVIDIA and AMD GPU servers from one central host over SSH. Cluster GPU Monitor stores
long-term utilization, per-user GPU hours, and idle-but-occupied cards in SQLite. Target nodes
need no agent, scheduler, or root access.

**It answers “do we need more GPUs?”, not only “which GPU is free right now?”**

[Live demo](https://mrzoyo.github.io/cluster-gpu-monitor/) ·
[Documentation](docs/README.en.md) ·
[Configuration](docs/CONFIGURATION.en.md) ·
[Deployment](docs/DEPLOYMENT.en.md)

## Why use it

Agentless dashboards show current processes but usually discard history. Prometheus / DCGM
stacks retain history but install components on every node. HPC accounting systems usually
depend on a scheduler. Cluster GPU Monitor fills the gap: **agentless collection, long-term
history, and username attribution in one small service.**

| Approach | Agentless | Long-term history | User attribution | Scheduler required |
| --- | :---: | :---: | :---: | :---: |
| Multi-host live dashboard | yes | no | yes | no |
| DCGM + Prometheus | no | yes | limited | no |
| HPC job accounting | no | yes | yes | yes |
| **Cluster GPU Monitor** | **yes** | **yes** | **yes** | **no** |

It fits teams with a handful to a few dozen self-managed GPU servers, no shared scheduler, and
a need for historical capacity data. Use a full telemetry and scheduling stack for thousand-node
fleets, second-level alerts, quotas, or billing.

## Highlights

- **Long-term utilization:** rolling averages from 12 hours to 1 month, with overview, cluster,
  host, and single-GPU drill-down.
- **Per-user GPU hours:** aggregate operating-system usernames across machines and break usage
  down by capacity domain, cluster, and host.
- **Idle-but-occupied detection:** flag GPUs that hold VRAM while recent utilization stays below 5%.
- **Multi-cluster topology:** model capacity domain → cluster → host, with badges, planned capacity,
  and soft retirement.
- **NVIDIA and AMD:** auto-detect `nvidia-smi`, `amd-smi`, or `rocm-smi`.
- **Small self-hosted stack:** SQLite, FastAPI, vanilla JavaScript, and bundled ECharts; no frontend
  build step.

## Quick start

The central host needs Python 3.12+, [uv](https://docs.astral.sh/uv/), and the system `ssh`
client. Target nodes need `bash`, `ps`, coreutils, and the vendor SMI tool.

```bash
git clone https://github.com/MrZoyo/cluster-gpu-monitor.git
cd cluster-gpu-monitor
uv sync

cp config/inventory.example.yaml config/inventory.yaml
cp config/settings.example.toml config/settings.toml
$EDITOR config/inventory.yaml

SSH_ALIAS=my-a-1                  # replace with one ssh_alias from the inventory
ssh "$SSH_ALIAS" true             # confirm non-interactive login
uv run gpumon config-check        # validate topology, expected GPUs, and runtime settings
uv run gpumon initdb
uv run gpumon collect --once      # test one collection round
uv run gpumon web                 # http://127.0.0.1:8848/
```

Every `ssh_alias` in `inventory.yaml` must match an entry in the central host's
`~/.ssh/config`. Keep bastions, ports, keys, and host-key policy in SSH configuration;
the collector calls the system `ssh` client and preserves those settings.

To view the dashboard from another machine, create a tunnel:

```bash
ssh -N -L 8848:127.0.0.1:8848 <monitor-host>
```

Then open `http://127.0.0.1:8848/`. See the [deployment guide](docs/DEPLOYMENT.en.md) for
long-running services, systemd, backups, and HTTPS.

## How it works

```text
GPU nodes (no agent installed)
    ↑  ssh <alias> bash -s
Collector: GPU / processes / CPU / RAM / load
    ↓
SQLite: raw samples → 5-minute rollups → 1-hour rollups
    ↓
FastAPI /api/* → vanilla HTML + JavaScript + bundled ECharts
```

- The remote script runs from stdin and writes no files on target nodes.
- Raw samples support username attribution; two rollup tiers keep long-window queries small.
- GPU cards separate recent activity from the selected window's average, which avoids treating
  training-step oscillation as meaningful capacity change.
- The Web process can use a separate account with read-only SQLite access and no SSH key access.

See [Architecture and trade-offs](docs/ARCHITECTURE.en.md) for query windows, data lifecycle,
metric semantics, and security boundaries.

## Minimal configuration

```yaml
version: 1

clusters:
  - key: training
    name: "Training cluster"
    hosts:
      - key: node-1
        ssh_alias: gpu-node-1
        display_name: "GPU Node 1"
        gpu_count: 8
```

`key` anchors history and should remain stable after deployment. When addresses, ports, or
bastions change, update `ssh_alias` and `~/.ssh/config` instead. See the
[configuration reference](docs/CONFIGURATION.en.md) for every field, badges, AMD, retention,
concurrency, and query limits.

## Production and security

`gpumon web` has **no built-in authentication** and listens on `127.0.0.1` by default. Put it
behind an authenticating HTTPS reverse proxy before sharing it with a team. The repository
includes systemd and Caddy templates.

For production:

- Run collector / backup and Web under separate system accounts; the Web account needs no SSH key.
- Keep real `inventory.yaml`, `settings.toml`, password hashes, DNS tokens, and private keys on the
  deployment host.
- Use immutable releases with separate configuration and data directories, plus a previous release
  for rollback.
- Use the built-in online SQLite backup instead of copying a live WAL database.

The [deployment guide](docs/DEPLOYMENT.en.md) covers installation, HTTPS, operations,
troubleshooting, and rollback.

## Documentation

| Goal | English | 简体中文 |
| --- | --- | --- |
| Choose a guide | [Documentation index](docs/README.en.md) | [文档目录](docs/README.md) |
| Configure hosts and runtime | [Configuration reference](docs/CONFIGURATION.en.md) | [配置参考](docs/CONFIGURATION.md) |
| Understand collection and metrics | [Architecture and trade-offs](docs/ARCHITECTURE.en.md) | [架构与设计取舍](docs/ARCHITECTURE.md) |
| Generate or publish demo data | [Demo guide](docs/DEMO.en.md) | [Demo 指南](docs/DEMO.md) |
| Deploy, operate, and troubleshoot | [Deployment guide](docs/DEPLOYMENT.en.md) | [部署指南](docs/DEPLOYMENT.md) |

## Limits

- User attribution comes from the operating-system username reported by `ps`; it does not model
  scheduler jobs, projects, or cost centers.
- The NVIDIA path runs in production. The AMD parser has synthetic fixtures but still needs
  validation on real AMD hardware.
- SQLite suits small and medium self-managed fleets, not thousand-node high-frequency telemetry.
- The project has no built-in login, authorization system, or alerting engine. Network controls and
  the reverse proxy provide access control.

## Development

```bash
uv sync --extra dev
uv run pytest -q
python3 scripts/check_added_secrets.py --self-test
python3 scripts/check_added_secrets.py --staged
```

Backend code lives in `src/gpumon/`; the frontend lives in `web/`. When filing an issue or patch,
include the GPU vendor, SMI version, reproduction command, and sanitized output. Never submit real
topology, usernames, credentials, or databases.

## License

[MIT](LICENSE)
