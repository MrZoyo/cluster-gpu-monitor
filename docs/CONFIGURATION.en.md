# Configuration Reference

Two files, both under `config/`, both **not checked into repo** (`.gitignore` already excludes them):

| File | What it controls | What to do after changing |
| --- | --- | --- |
| `inventory.yaml` | Which machines, how to group them, how to display | `systemctl restart gpumon-collector` (add `gpumon-web` for retired machines) |
| `settings.toml` | Poll interval, retention days, port, privacy | Restart corresponding service (poll params→collector, port→web) |

Start by copying from examples:

```bash
cp config/inventory.example.yaml config/inventory.yaml
cp config/settings.example.toml config/settings.toml
uv run gpumon config-check          # Always run this after any changes
```

`config-check` prints the final effective capacity groups, palette assignments, badges for each cluster, and expected GPU count for each host. **Misconfigurations show up at this step**, no need to wait for the web UI.

---

## inventory.yaml

### Three-tier Topology

The hierarchy is fixed at three levels. Just fill in this structure and web UI, stats tables, rankings, and coloring all adapt automatically:

```
capacity_group               ← Coarsest grouping, e.g. "Self-owned" / "Rented" / "Partner X"
  └─ cluster                 ← A batch of machines, usually same datacenter / procurement / bastion
       └─ host               ← One physical machine
            └─ GPU           ← Auto-discovered on first collection, no manual entry
```

GPUs don't need to be declared in config — the collector writes card UUID, model, and VRAM into the database on first connection. You only need to specify `gpu_count` as the **expected value** for "missing GPU" detection.

### Minimal Working Config

```yaml
version: 1

clusters:
  - key: my-cluster
    name: "My Cluster"
    hosts:
      - { key: node-1, ssh_alias: node-1, display_name: "Node 1" }
```

No `capacity_groups`, no `capacity_group` specified? Still works — falls back to a neutral catch-all domain (default name "Ungrouped", customizable via `defaults`).

### Top-level Fields

```yaml
version: 1                    # Config format version, always 1

defaults:
  gpu_count: 8                # Fallback when host doesn't specify gpu_count
  poll_interval_s: 30         # Compatibility field; actual interval from settings.toml
  fallback_group_key: default     # Where clusters without capacity_group go
  fallback_group_name: "Ungrouped"    # Display name for that fallback domain
```

### capacity_groups (Capacity Domains)

```yaml
capacity_groups:
  - key: own                  # Stable identifier, clusters reference this
    name: "Self-owned Capacity"  # Display name, change freely
    sort_order: 1             # Ordering, smaller first
    palette: lime             # Optional: specify color family
    description: "Self-purchased and managed"   # Optional: shown under domain header
    badges: [self-built]      # Optional: domain-level badges, see badges section below
```

**palette can be omitted.** When omitted, bands are assigned by rotating through `sort_order`, guaranteeing each domain gets a distinct recognizable color family. Eight built-in bands:

| Band | Hue | Band | Hue |
| --- | --- | --- | --- |
| `lime` | yellow-green → green → cyan-blue | `rose` | rose → magenta |
| `violet` | magenta → violet | `teal` | jade → cyan |
| `azure` | cyan → sapphire | `indigo` | indigo → ultramarine |
| `amber` | amber → orange-brown | `slate` | neutral gray-blue |

More than 8 domains? No problem: the frontend generates new hues via golden angle, never degrades to uniform gray.

Within a band, there are two levels of distinction: **different clusters in the same domain spread along the hue axis, different hosts in the same cluster vary in lightness**. At a glance you can tell "these machines belong to one cluster."

> Utilization red/orange/yellow/green/gray are **semantic colors** with fixed meaning, separate from capacity domain family colors — two independent systems, no interference.

### clusters

```yaml
clusters:
  - key: cluster-a            # Stable identifier, history linked by it, don't change after going live
    name: "Cluster A"         # Display name, change anytime
    sort_order: 1
    capacity_group: own       # References domain key above; empty = fallback domain
    status: active            # active (default) / planned / retired
    note: "Remark, only shown when status: planned (web hover tooltip)"
    badges: [...]             # See next section
    hosts: [...]
```

### badges (Custom Badges)

Small pill badges to mark any attribute you want to emphasize. **Both capacity domains and clusters can have them**, syntax identical (hosts don't support badges).

Recommended practice: Define badges in top-level `badge_library`, reference by key elsewhere. This way badges like "Self-built" that appear in multiple places are defined once, changing text/tooltip updates all references.

```yaml
badge_library:
  - key: self-built
    text: "Self-built"                 # Required
    mark: "◆"                          # Optional: prefix symbol
    tone: cyan                         # Optional: cyan/gold/green/violet/neutral
    tooltip: "On-prem installation, self-service account signup"    # Optional: hover text
  - key: infiniband
    text: "InfiniBand"
    tone: green

capacity_groups:
  - key: own
    name: "Self-owned Capacity"
    badges: [self-built]               # Domain uses badge

clusters:
  - key: cluster-a
    name: "Cluster A"
    badges: [self-built, infiniband]   # Cluster references same two badges
```

Badges used in only one place don't need the library, can be inlined; both styles can mix, order follows declaration order:

```yaml
    badges:
      - self-built                                    # Library reference
      - { text: "ROCm", tone: gold, tooltip: "Requires ROCm-enabled framework" }   # Inline
```

- A domain/cluster can have any number, **>3 automatically collapse to `+N`**, hover to expand full list.
- `tone` only accepts these five preset names, not arbitrary CSS colors — deliberately prevents badge colors from clashing with utilization semantic colors / domain family colors.
- Referencing a non-existent key errors at startup with available options listed, won't silently drop badges.

> **Upgrading from pre-v0.3.0 config**: `configured_by: "Ops Team"` has been removed. It used to auto-generate a `◆ Ops Team configured` badge. Replace with: define one badge in library, reference it in cluster `badges`; keeping the old field will error at startup with migration instructions (not silently ignored, otherwise that badge vanishes without trace).

### hosts (Servers)

```yaml
    hosts:
      - key: node-1                    # Stable identifier, history linked by it, don't change after going live
        ssh_alias: my-node-1           # Alias in ~/.ssh/config
        display_name: "Node 1"         # Display name, change anytime
        gpu_count: 8                   # Expected GPU count, defaults to defaults.gpu_count
        status: active                 # active (default) / planned / retired
        vendor: amd                    # Optional, empty=auto-detect (nvidia-smi → rocm-smi)
        note: "Remark, only shown when status: planned (web hover tooltip)"
        meta:
          gpu_model: "AMD Instinct MI300X"   # Model shown on planned placeholder cards
```

**Required fields**: `key`, `ssh_alias`, `display_name`. Others have defaults.

The division of labor between `key` and `ssh_alias` is critical:

- **`key` is the history anchor**, all samples in database hang on it, **never change**.
- **`ssh_alias` is how to connect**, can change anytime. Migrating deployment host, adding bastions, changing IPs: only modify ssh config and this field, keep `key` unchanged → **history curves stay continuous**.

**Cross-network / internal machines**: Use `ProxyJump` in deployment host's `~/.ssh/config` to declare bastion, `inventory.yaml` only writes the internal machine's alias. When collector runs `ssh <alias>`, ssh automatically goes through bastion.

```sshconfig
# ~/.ssh/config (on deployment host, for collector user)
Host my-bastion
  HostName 1.2.3.4
  User root

Host my-node-1
  HostName 10.0.1.100         # Internal address
  User ubuntu
  ProxyJump my-bastion        # ← Actual bastion declaration here
```

Then `inventory.yaml` just writes `ssh_alias: my-node-1`, no extra fields needed.

**When to write `meta.gpu_model`**: Only needed for `status: planned` placeholder — because the machine is unreachable and uncollectable, placeholder cards need to show "8× NVIDIA H100" so they read from `meta`. For normally online machines, model comes from collection (`nvidia-smi -L` / `rocm-smi --showproductname`), stored in database, so even if `meta` is empty and machine goes offline, web UI still shows model — as long as it was collected at least once while alive.

### Three status Values

| Value | Collector | Web UI | Database | When to use |
| --- | --- | --- | --- | --- |
| `active` | Normal probing | Normal display | Normal writes | Default |
| `planned` | No probing | Show placeholder cards (gray `--`) | None | Machine not yet arrived / no access yet, reserve the spot |
| `retired` | Stop probing | Entire host hidden | **History fully preserved** | Machine decommissioned/returned |

**Don't delete retired machines from inventory.** Deleting the config entry while database history rows remain causes web UI to show perpetually offline ghost cards. Mark `retired` is the correct way: collector stops connecting, web UI removes it from everywhere (overview / cluster page / host page / health lights / user rankings), but history data stays intact for future auditing.

After marking `retired`, restart **both** services: `gpumon-collector` (stop probing) and `gpumon-web` (clear inventory cache).

### vendor and AMD

When `vendor` is empty, remote probe script tries in order: `nvidia-smi` → `amd-smi` → `rocm-smi`, uses whichever succeeds. Only explicitly write when auto-detection guesses wrong:

```yaml
      - { key: amd-1, ssh_alias: amd-1, display_name: "AMD-1", vendor: amd }
```

Typical scenario requiring hardcoding: machine has NVIDIA driver packages but AMD cards, or has drivers but currently no working cards causing unstable detection.

> AMD support is implemented per `rocm-smi` / `amd-smi` official output format and unit-tested with synthetic samples, **not yet validated on real AMD hardware**. When connecting first AMD machine, recommend running `./scripts/probe_one.sh <alias>` to check raw output, confirm `##VENDOR` / `##AMDSMI_*` sections have content.

---

## settings.toml

```toml
[collector]
poll_interval_s = 30        # Interval between collection rounds. Also the GPU-hour accounting granularity
ssh_connect_timeout_s = 8   # SSH connection timeout
ssh_total_timeout_s = 20    # Overall timeout per host per round (includes remote sleep)
max_concurrency = 8         # How many simultaneous SSH connections. Increase for many machines, mind bastion capacity
cpu_sample_gap_s = 1        # Interval between two /proc/stat reads on remote, for CPU utilization
ssh_output_limit_bytes = 4194304 # Combined stdout+stderr budget per host; excess terminates SSH

[retention]
raw_days = 31               # Raw sample retention days
rollup_5m_days = 30         # 5-minute aggregation retention days
rollup_1h_days = 400        # 1-hour aggregation retention days

[db]
path = "data/gpumon.db"     # Relative to project root

[web]
host = "127.0.0.1"          # Keep 127.0.0.1 behind reverse proxy; change to 0.0.0.0 for direct access
port = 8848

[privacy]
mask_users = false          # true shows users as a***e

[backup]
enabled = true              # Whether to enable automatic backup (systemd timer checks this switch)
keep_count = 3              # Keep N most recent backups
```

### Backup Configuration

Automatic backups are scheduled only by the systemd timer, once daily at 04:00 by default.

- `enabled`: Whether scheduled backups are enabled. When `false`, the timer can still fire but
  `gpumon backup --scheduled` exits successfully without creating a backup. Manual
  `gpumon backup` commands are unaffected.
- `keep_count`: Keep N most recent backup files. Default 3, i.e. can restore to 3 days ago max.

Each backup is written through the SQLite backup API to a temporary file. It must pass
`quick_check`, is set to mode `0600`, and is fsynced before an atomic rename. Old backups
are pruned only after the new file is published successfully.

**To change the backup time**, edit the systemd timer. There is deliberately no separate
settings value that could drift from the real schedule:

```bash
# Edit timer (OnCalendar line)
sudo systemctl edit --full gpumon-backup.timer

# Example: change to 8 AM daily
# OnCalendar=*-*-* 08:00:00

# Reload and restart timer
sudo systemctl daemon-reload
sudo systemctl restart gpumon-backup.timer
```

Manual backup: `uv run gpumon backup` (backup once immediately, clean old backups per `keep_count`).

### How to Set Retention Days (There's a Gotcha)

Three tables each manage a time range, queries auto-pick table by window:

- **≤24h windows** use 5-minute aggregation table
- **>24h windows** use 1-hour aggregation table (never touches raw table, so long windows are fast too)
- **User rankings scan raw `sample_proc` table**

The last point is the gotcha: **`raw_days` must be ≥ longest time window you want + margin**. Default `raw_days = 31` just covers 1-month window (30 days). If you reduce it to say 7 days, then "last month user ranking" only counts the most recent 7 days of data, **no error, but numbers are low**.

`rollup_1h_days` similarly must exceed longest window, default 400 days leaves ample margin.

### Concurrency and Bastions

`max_concurrency` is the number of simultaneous SSH connections. Want to increase for many machines, but note: if all machines go through same bastion, bastion's `MaxSessions` / `MaxStartups` becomes the bottleneck first, manifesting as random timeouts on some machines. Safe approach: increment gradually (8 → 16), watch `/api/collector/status` for new timeouts.

---

## After Changes

| What changed | What to do |
| --- | --- |
| Add machines / clusters / change display names / change badges | `systemctl restart gpumon-collector` |
| Mark `retired` | `systemctl restart gpumon-collector gpumon-web` |
| Change collection params (interval / timeouts / concurrency) | `systemctl restart gpumon-collector` |
| Change port / listen address / privacy switch | `systemctl restart gpumon-web` |
| Change retention days | Next auto-cleanup takes effect, or `uv run gpumon rollup-once` |
| Only changed files under `web/` | Nothing needed, refresh browser |

Verify changes took effect:

```bash
uv run gpumon config-check                      # Config level
curl -s 127.0.0.1:8848/api/collector/status     # Each host online / GPU count / recent errors
curl -s 127.0.0.1:8848/api/health               # How long ago was last sample
```
