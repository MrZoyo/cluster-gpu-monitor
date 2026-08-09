# cluster-gpu-monitor

[简体中文](README.md) | English

Self-hosted monitoring for multi-cluster GPU servers: **no agent, no root, no scheduler**.
A plain SSH connection is all it takes to record utilization, VRAM, temperature, power and
*who is using what* into SQLite. It answers **"do we need to buy more GPUs"**, not
"which card is free right now".

The primary metric is the **rolling average** of GPU utilization
(12h / 24h / 48h / 72h / 1 week / 2 weeks / 1 month), paired with a per-user GPU-hours
leaderboard and idle-but-occupied detection, so capacity decisions rest on real data.

## Why another one

GPU monitoring tools cluster into two camps, and there is a gap between them:

- **"Who's free right now" dashboards** (gpustat-web, gpuview, ssh-dashboard, nvitop):
  also agentless, and they do show per-user processes — but they keep **no history**,
  so they cannot answer "what was our average utilization last month".
- **Long-term metric stacks** (DCGM + Prometheus + Grafana) and **HPC job accounting**
  (jobstats-style tooling, GCM-style systems): history and per-user attribution are there,
  but the price is **a per-node agent or daemon**, or **a scheduler**
  (Slurm, k8s) to attribute usage to people.

This project sits in the gap: agentless collection, long-term history, and per-user
attribution, all three at once.

|                          | Agentless | Persistent history | Per-user attribution | Scheduler required |
| ------------------------ | :-------: | :----------------: | :------------------: | :----------------: |
| Multi-host "who's free"  |    yes    |         no         |         yes          |         no         |
| DCGM + Prometheus        |    no     |        yes         |       limited        |         no         |
| HPC job accounting       |    no     |        yes         |         yes          |        yes         |
| **This project**         |  **yes**  |      **yes**       |       **yes**        |       **no**       |

How: a central host SSHes into each node to run `nvidia-smi` / `rocm-smi` plus `ps`,
attributes usage to users via the username parsed from `ps` (no Slurm, no k8s),
and writes raw samples into SQLite with **two-tier pre-aggregation** so an average over
any window comes back instantly.

Good fit: a handful to a few dozen self-managed GPU boxes, no shared scheduler, and a need
for **long-term data you can take into a budget conversation**.
Not a fit: thousand-node cluster telemetry (use a DCGM exporter) or second-level alerting.

## Features

- **Rolling average utilization** over 12h / 24h / 48h / 72h / 1w / 2w / 1m, with drill-down
  from overview to cluster to host to a single card.
- **Per-user GPU-hours leaderboard**, aggregated across machines by username, with a
  breakdown stacked by capacity domain, cluster and host.
- **Idle-but-occupied detection**: cards holding VRAM while recent utilization stays below
  5% get their own marker, which is how you find wasted reservations.
- **NVIDIA + AMD (ROCm)**: vendor is auto-detected on the remote host, or pinned in the
  inventory (see the AMD note below).
- **Multi-cluster / capacity-domain grouping**: a three-level topology where each domain
  gets its own color family automatically, no manual palette work.
- **Fully customizable names and badges**: display names plus badges
  (text, prefix mark, tooltip, semantic tone) all live in the inventory.
- **Light and dark themes**; charts use a **bundled local ECharts**, no external CDN,
  so it works on air-gapped networks.
- **Offline and missing-card awareness**: a host that misses the liveness threshold is
  marked offline and shows "offline" instead of its last stale occupancy, and it is excluded
  from current averages and busy counts. Discovering fewer cards than the inventory expects
  is surfaced in the UI.
- **Soft retirement**: mark a decommissioned box `status: retired` and the collector stops
  probing it and the UI hides it, while every history row stays in the database.

## Architecture

```
Monitored nodes (nothing installed)
    ↑ ssh <alias> bash -s        ← ordinary user, script piped via stdin, nothing written remotely
Collector                        ← one connection fetches everything: GPU / processes / CPU / RAM / load
    ↓
SQLite (WAL) ─ raw samples ─→ 5-minute rollup ─→ 1-hour rollup
    ↓
FastAPI (/api/*) ─→ vanilla HTML + JS + local ECharts (no build step)
```

- **Collection**: SSH polling (pull), 30s per round by default, with a configurable
  concurrency cap. It shells out to the system `ssh` rather than using paramiko, so it
  inherits aliases, `ProxyJump`, keys and known_hosts straight from `~/.ssh/config` —
  no IP, port, password or private key ever appears in the code, and moving to a different
  central host is just an ssh config change. The remote side only needs coreutils, the
  vendor smi tool and `ps`.
- **Storage**: SQLite with WAL. Raw samples plus 5-minute and 1-hour rollups. Queries pick a
  table by window size: 5-minute buckets for ≤24h, 1-hour buckets for anything longer
  (see `WINDOWS` and `pick_table()` in `src/gpumon/db/store.py`), so even a one-month
  average never scans the raw tables. The collector loop advances rollups incrementally
  (5-minute buckets every minute, 1-hour buckets every 5 minutes) and runs retention cleanup
  hourly.
- **Backend**: FastAPI — JSON endpoints plus serving `web/` as a static site.
- **Frontend**: vanilla HTML/JS. No bundler, no node_modules; edit and refresh.

One deliberate design choice: **the big number on a GPU card is "recent utilization"**
(a 10-minute average, with a "zero it out after 3 consecutive samples ≤5%" rule). That
smooths the 0/100 flicker between training steps while still dropping to idle the moment a
job stops. The small "avg" figure underneath is the long-term average over the selected
window. True instantaneous values live only in the tooltip and the single-card page.

Utilization colors are **semantic** — red at full load, then orange, yellow, green for in-use
and grey for idle, with fixed meaning (thresholds in `utilColor`, `web/js/components.js`).
Capacity domains and clusters instead use **family colors** (the 8 built-in `Palette` bands:
lime, violet, azure, amber, rose, teal, indigo, slate) purely to express *which* domain or
cluster something belongs to. The two systems never interfere. Once the built-in bands are
exhausted, new hues are generated by golden-angle rotation, so a ninth domain still gets a
distinct color instead of falling back to grey.

## Requirements

- **Central host**: Python 3.12+ and an `ssh` client. [uv](https://docs.astral.sh/uv/) is
  recommended for dependency management.
- **Monitored nodes**: `bash`, `nvidia-smi` (or `rocm-smi` / `amd-smi`), `ps`, coreutils, and
  an ordinary account you can log into without a password prompt.
  **No root, nothing to install.**

## Quick start

```bash
git clone <this-repo>
cd cluster-gpu-monitor
uv sync

cp config/inventory.example.yaml config/inventory.yaml   # your machines
cp config/settings.example.toml  config/settings.toml    # interval, retention, etc.

uv run gpumon config-check     # validate: prints domains, clusters, hosts, expected cards, palettes
uv run gpumon initdb           # create tables + sync topology
uv run gpumon collect --once   # one probe round (add --host <key> for a single machine)
uv run gpumon web              # serve http://127.0.0.1:8848/
```

This assumes `~/.ssh/config` on the central host already has an entry for every `ssh_alias`
in the inventory and that login needs no interaction. Confirm with `ssh <alias> true` before
running `collect --once`.

Other subcommand: `gpumon rollup-once` runs aggregation and retention cleanup by hand
(the long-running collector does this automatically).

A production setup runs two processes: `gpumon collect` (the polling loop) and `gpumon web`.
`web` listens on `127.0.0.1` only and **ships with no authentication of its own** — if you
expose it, put a reverse proxy with auth in front of it (`deploy/` has systemd and Caddy
templates).

## Configuration

Two files, both gitignored:

- `config/inventory.yaml` — the machine list, and **the single source of truth** for the
  whole system.
- `config/settings.toml` — runtime knobs: poll interval, SSH timeouts, concurrency,
  retention, DB path, listen address, and whether to mask usernames
  (`mask_users = true` renders them as `a***e`).

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full field reference,
the palette list, badge syntax, `status` semantics, and the retention gotcha.
(Reference is in Chinese; the example configs are commented in both.)

### Three-level hierarchy

The hierarchy is fixed at three levels. Page grouping, summary tables, the leaderboard and
all coloring adapt to it, so **adding machines never means touching code**:

```
capacity domain (capacity_group)   own / rented / partner ... your call; one color family each
└── cluster                        a set of machines plus cluster-level badges
    └── host                       one alias in ~/.ssh/config
```

```yaml
capacity_groups:
  - { key: own, name: "Own capacity", sort_order: 1, palette: lime }

clusters:
  - key: cluster-a
    name: "Cluster A"
    capacity_group: own
    badges:
      - { text: "self-hosted", mark: "◆", tone: cyan, tooltip: "Racked in-house, self-service accounts" }
      - { text: "InfiniBand", tone: green }
    hosts:
      - { key: node-1, ssh_alias: my-node-1, display_name: "Node-1",
          meta: { gpu_model: "NVIDIA A100 80GB" } }
```

Key conventions:

- **Never change a `key` once it is live** — history is linked by it. When a machine moves to
  a different central host, change only `ssh_alias`; the `key` stays and the history stays
  continuous.
- `palette` can be omitted; bands are assigned by rotating through the domains' `sort_order`.
- `gpu_count` is the expected card count, used for missing-card and offline detection.
  Falls back to `defaults.gpu_count`.
- Leave `vendor` empty for remote auto-detection (`nvidia-smi` → `amd-smi` → `rocm-smi`);
  pin it only if detection guesses wrong.
- `status`: `active`, `planned` (not yet onboarded, shown as placeholder cards), or
  `retired` (soft retirement).
- Multiple `badges` render on the cluster card header; beyond three they collapse into "+N".
  `tone` accepts only the preset names (cyan, gold, green, violet, neutral).

Restart the collector after editing the inventory — topology is upserted and GPUs are
discovered on the first round. Run `gpumon config-check` first; it prints the effective
domains, palettes, clusters, hosts and total card count.

### Retention

Three numbers under `[retention]`, one per tier:

| Setting | Default | Notes |
| --- | --- | --- |
| `raw_days` | 31 | Raw samples. **Must be ≥ longest window plus headroom**, or the one-month user leaderboard undercounts |
| `rollup_5m_days` | 30 | 5-minute rollups, used by windows ≤24h |
| `rollup_1h_days` | 400 | 1-hour rollups, used by windows >24h |

Note that **the user leaderboard scans raw process samples**, so its reach is bounded by
`raw_days`. Utilization charts and averages read the rollup tables and are unaffected.

## AMD (ROCm) support status

To be upfront about it: the AMD path is **implemented against the documented `rocm-smi` /
`amd-smi` output formats and unit-tested with synthetic samples, but has not yet been
validated on real AMD hardware.** The NVIDIA path is what runs in production today.

Implementation notes: the remote side forwards the raw smi JSON verbatim and all parsing
happens in Python (`src/gpumon/collector/parse_amd.py`), matching fields by key name anywhere
in the nested structure and normalizing units — because amd-smi's field names and nesting
have changed across ROCm point releases. Process-to-GPU mapping on `rocm-smi` depends on
`--showpidgpus`, which some versions do not have; without it, processes cannot be tied to a
specific card.

If you have AMD hardware, running `scripts/probe_one.sh <alias>` and pasting the raw output
into an issue would help a lot — or send a PR fixing the field names directly.

## Development

```bash
uv run --extra dev pytest        # unit tests: parsing, rollups, inventory validation, retirement
scripts/probe_one.sh <alias>     # dump one machine's raw probe output to debug parsing
scripts/verify_e2e.sh            # probe → rollup → verify DB contents and API endpoints
```

- Backend `src/gpumon/`: `collector/` for probing and parsing, `db/` for storage and
  aggregation, `api/` for endpoints.
- Frontend `web/`: vanilla HTML + JS + local ECharts, no build step.
- Code comments are in Chinese.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full systemd plus reverse-proxy walkthrough,
directory layout and operational commands. Templates live in `deploy/` (systemd units and a
Caddyfile example).

Worth repeating: `gpumon web` has no built-in authentication. Always put an authenticating
reverse proxy in front of it.

## License

[MIT](LICENSE)
