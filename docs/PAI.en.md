# PAI Monitoring

[简体中文](PAI.md) | English | [Documentation](README.en.md) | [Project home](../README.en.md)

The optional PAI module displays Alibaba Cloud PAI quotas, nodes, DSW/DLC workloads, user usage,
and utilization charts. A separate collector reads cloud APIs into `pai.db`. Web reads that local
snapshot; refreshing a page never calls cloud APIs.

## Disabled by default

Without `config/pai.toml`, or with `enabled = false`, the site keeps its bare-metal overview.
There is no PAI navigation or two-module home page; `/api/pai/*` returns ordinary 404 responses,
and `#/pai...` redirects to the overview. Missing or invalid configuration leaves PAI routes
unregistered. Restart Web after changing the enabled state.

When enabled, the home page offers separate bare-metal and PAI entries. `#/baremetal` opens the
bare-metal overview; existing cluster, host, GPU and ranking links continue to work. Identities
and accounting remain separate between the two resource types.

## Start collecting

Complete the [README quick start](../README.en.md#quick-start) first so Web has inventory, settings
and a bare-metal database. Install and configure the PAI CLI separately. The adapter has been
verified with official CLI v1.0.1 and the `pai-tui` wrapper using that engine; `cli_path` can select
either compatible executable. The collector uses a process lock and supports Linux/macOS.

1. Copy [pai.example.toml](../config/pai.example.toml) to private `config/pai.toml`.
2. Set the account, region, workspace, root quota, `enabled = true`, and the correct `cli_path`.
3. Configure read access in the collector's CLI identity. Keep credentials out of TOML, source code and Web.
4. Test one round, then start the collector and Web using the same configuration/data root.

```sh
export GPUMON_ROOT=/absolute/path/to/runtime
export GPUMON_PAI_CONFIG="$GPUMON_ROOT/config/pai.toml"

uv run python -m gpumon.pai.collector --once
uv run python -m gpumon.pai.collector
# In another terminal, set the same two variables before starting Web.
uv run gpumon web --host 127.0.0.1 --port 8848
```

Each round verifies the STS account before other reads. An account mismatch stops that round.
Required reads cover quotas, nodes, pods, workloads, user usage, DLC job details and CloudMonitor
metrics. Verify them under the dedicated identity before deployment. Successful read checks do
not prove that the identity lacks other permissions; this module does not probe write operations.

## Configuration

Relative `db_path` values resolve against `GPUMON_ROOT`. The default configuration path is
`config/pai.toml` under that root; override it with `GPUMON_PAI_CONFIG`. Unknown fields fail validation.

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in; account, workspace and quota are required when enabled |
| `region` | `cn-hangzhou` | Cloud region |
| `account_id` / `workspace_id` / `quota_id` | Empty | Expected STS account, workspace and root quota |
| `cli_path` / `profile` | `pai-tui` / empty | Executable and CLI profile; profile credentials override environment variables |
| `db_path` | `data/pai.db` | Separate PAI database |
| `baremetal_notice` | Empty | Optional notice on bare-metal pages when PAI is enabled |
| `poll_interval_s` / `degraded_interval_s` | `120` / `180` | Normal and repeated-failure polling intervals |
| `topology_interval_s` / `stale_after_s` | `300` / `600` | Quota/node cache cadence and ordinary-source stale threshold |
| `request_timeout_s` / `round_timeout_s` | `12` / `100` | Per-CLI-call and total-round time budgets |
| `max_calls` / `concurrency` | `120` / `2` | Per-round call budget and parallelism; small hosts can use one worker |
| `max_pages` / `max_workloads` / `max_nodes` | `8` / `32` / `64` | Pagination, workload-metric and node bounds |
| `metric_window_s` / `retention_hours` | `600` / `24` | Overlapping read window and raw-point retention |
| `host_metric_interval_s` | `240` | Workload CPU/RAM metric refresh cadence |
| `job_refresh_s` / `queued_job_refresh_s` | `21600` / `600` | Running/queued DLC detail cache cadence |
| `max_job_details` | `8` | Maximum DLC details refreshed per round |

Two failed rounds reduce polling frequency; two successful rounds restore it. Throttling stops
new requests and backs off for at least 600 seconds, with further backoff on repeated throttling.
Budget or pagination failures retain the last successful values and are not reported as complete
coverage. See [PaiSettings](../src/gpumon/pai/config.py) for validation ranges.

## Pages and metric semantics

| Page | Contents |
| --- | --- |
| Overview | Quota allocation, physical GPU heatmap, low-utilization cues, queue and source health |
| Nodes | Per-card mappings, quotas, health and workload drill-down |
| Workloads | Search/filter/sort, requested/scheduled resources, submission policies, pod specs and one-hour charts |
| Users | Owner/submitter workloads, in-quota and idle-time usage, source discrepancies |
| Rankings | Feature/Quota ranking for the current week by default; switch to users, last week or the existing rolling windows; CSV export |

- Physical GPUs are deduplicated by node/card. Parent quotas include children and must not be added together.
  Requested, scheduled, quota-allocated and physically mapped resources are separate quantities.
- Physical mapping requires the pod metric GPU-index set to match `GPUIndexes`. Ambiguous mappings or
  multiple workloads sharing a card remain unknown.
- `UseOversoldResource` describes actual idle-time allocation for a scheduled workload. It differs from
  submission policy and quota sharing. Hidden nodes do not prove that a workload runs outside the listed
  nodes; idle-time workload GPU counts are not added to the physical total.
- Queue guidance considers submission policy, quota capacity and per-pod specifications while preserving
  the scheduler's reason. Missing evidence does not justify a definite scheduling conclusion.
- Charts retain workload/pod/GPU dimensions and source timestamps in fixed 120-second buckets. Late points
  can revise buckets; gaps are not zero. Metrics remain available without a physical-node mapping, and
  current physical ownership is not backfilled into history.
- “Compute mean (tasks)” on home and overview averages the latest fresh compute metrics across GPUs in
  running tasks, with equal weight per GPU, including unmapped idle-time tasks. Unallocated GPUs and missing
  or stale values are excluded. This is not an equal-weight average of task averages.
- “Cluster utilization” averages across all physical GPUs, counting confirmed unallocated cards as 0%.
  Confirmation requires fresh nodes, workloads and pod mappings, with node GPU requests no greater than
  mapped allocations. Missing allocated metrics or uncertain allocation produces “—”, not assumed idle.
  Unmapped idle-time tasks are excluded from both numerator and denominator. For example, 64 fully busy
  and 64 unallocated GPUs in a 128-GPU cluster yield 50%.
- Workload and user detail pages may retain last-successful stale metrics and mark them; the overview task
  mean uses fresh metrics only.
- Low-utilization cues use a ten-minute mean with at least five minute samples. Stale values remain visible
  but do not trigger that cue. CPU/RAM utilization is a percentage of the pod limit; requested amounts are separate.
- Attribution comes from RAM owners/submitters, not CloudMonitor's account-level `userId` or individual
  processes inside shared containers.
- GPU hours use workloads successfully read in the current round with status Running. Long gaps count at
  most twice the degraded interval; known zero scheduled GPUs remain zero. UTC-hour buckets retain 32 days;
  window edges may include part of an extra hour. These are observed estimates, not billing records.

### Weekly feature ranking

The default window runs from Monday 00:00 Beijing time (Asia/Shanghai) to now; last week is the
previous full calendar week. Rolling windows remain available. PAI window and dimension choices are
independent of bare-metal pages and survive automatic refresh. Features group workloads by the
`QuotaId` used at submission, so one user can appear under several features. Direct root-quota
submissions stay in their own row; the page never guesses an algorithm group from usernames. Weekly
reports per group therefore require submitters to choose the matching quota.

- **Task GPU hours** include in-quota and idle-time workloads, with idle-time shown separately. A workload
  counts only toward its submission quota and is never added again to a parent quota.
- **Current quota / usage / occupancy** come from the latest quota snapshot and always describe now, even
  when last week is selected. A stale snapshot is flagged. Allocated and ancestor-borrowed GPUs appear in the
  usage tooltip; they are not the feature's task usage.
- **Window quota occupancy** divides observed quota used GPU-seconds by capacity GPU-seconds over the same
  intervals, weighting quota changes by duration. It uses the platform's `gpu_used` and excludes idle-time
  capacity. Parent usage can include children; neither capacity nor usage can be added across levels.
  Missing data, zero capacity or no historical denominator leaves occupancy unknown; current capacity is
  never used to reconstruct history.
- **Compute utilization** is the mean of available workload samples. Effective GPU hours keep the existing
  compute-weighted estimate and show metric coverage. Compute is not quota occupancy, and occupancy is not
  compute efficiency.
- Quota history starts at the first observation after this feature was deployed and integrates the previous
  snapshot (the quota catalog refreshes about every five minutes). The first observation is not backfilled,
  failed snapshots are not carried forward, and long gaps count at most twice the degraded interval. Pool
  coverage appears in the summary; a quota whose coverage differs clearly from the pool is marked in its row.
  With partial coverage, occupancy describes only observed intervals, and task history may be longer.
  Quota history is kept for 32 days with the same hourly boundaries as task rankings.
- The page opens with a window summary: total GPU hours, pool quota occupancy, effective GPU hours, the
  current pool and active features. “Near full” (window occupancy ≥ 90%) and “Low compute” (compute mean
  < 10%) are cues only and do not change the order. Calculation notes are collapsed below the table.
- **CSV export** includes the window, generation time, task-history start, truncation flag and every returned
  row. Feature exports add capacity GPU hours, used GPU hours, observed hours, coverage and compute metrics
  for checking weekly reports. Unknown values are empty; exporting never sends reports or messages.

Pages refresh every 120 seconds while retaining scroll, filters and expanded sections; typing in the
search field postpones refresh. Source details include fetch times, sample times and failure categories.
Collection failure does not imply a failed cloud node, and no visible allocation does not guarantee
schedulable capacity. Health guidance never restarts DSW, stops DLC or changes cloud resources.

## Production deployment

The distribution includes the collector module but **does not install a cloud CLI, create identities,
or enable a PAI service automatically**. Existing systemd and Compose services handle bare-metal
monitoring. Configure a separate PAI collector service and CLI for your deployment:

- Use a dedicated non-login service account and pin the CLI version/checksum. Inject credentials only into
  the collector; Web must not read them. Ensure a CLI profile cannot override the intended environment identity.
- Create a separate data directory and grant Web read access through a shared group. Collector umask is
  0027, normally producing 0750 directories and 0640 database files. Check existing directory permissions
  separately. A persistent writer maintains WAL/SHM for read-only readers.
- Bound memory, CPU, tasks and API requests, and measure at least one complete collection cycle.
  Configured limits, round wall-clock duration and actual resource consumption are different measurements.
- Back up the bare-metal and PAI databases separately using SQLite online backups. Restart the separate
  collector after upgrading; stop it when rolling back to code without PAI, retaining data and credentials.
- Protect access with authenticated HTTPS. PAI data is excluded from the anonymous GPU summary, and there
  is no application-level rule restricting each user to their own workloads.

## Read-only API

| Endpoint | Contents |
| --- | --- |
| `/api/pai/status` | Enabled state, source health and coverage summary |
| `/api/pai/overview` | Complete current snapshot |
| `/api/pai/nodes` / `/api/pai/workloads` / `/api/pai/users` | Node, workload or user subsets |
| `/api/pai/metrics/series?workload_id=...` | One hour by default, configurable to 1–6 hours; at most 20,000 source points with `truncated` on overflow |
| `/api/pai/ranking?window=week` | Current week by default, `last_week` for the previous week; existing rolling windows remain valid. Returns `features` and `users`, at most 200 rows each |

Overview `summary` adds `task_compute_mean` / `task_measured_gpus` and `cluster_compute_mean` /
`cluster_known_gpus` / `cluster_unallocated_gpus`. The legacy `compute_mean` remains the fresh mapped
physical-GPU mean; `metric_denominator` is the physical count, not the task mean denominator.

## Validation, demo and limits

Run `uv run pytest -q tests/test_pai.py` and `node tests/frontend_security.js`. With Playwright installed,
run `node tests/browser_recovery.cjs`; `CHROME_BIN` selects a browser and `SHOT_DIR` saves screenshots
outside the repository. These checks use synthetic data and do not call cloud APIs.

The [live demo](https://mrzoyo.github.io/cluster-gpu-monitor/) uses `--with-pai` to generate fictional PAI
data without reading production settings, accounts or databases. Ordinary exports omit PAI; see the
[demo guide](DEMO.en.md).

There is no unified cross-platform identity, billing-grade accounting, per-PID attribution, exact physical
VRAM GiB accounting or PAI ranking history beyond 32 days. Cloud metrics may arrive late or remain missing,
and physical mappings may be incomplete. Overlapping reads do not guarantee complete data after a fixed delay.

API references: [ListQuotaWorkloads](https://help.aliyun.com/zh/pai/developer-reference/api-paistudio-2022-01-12-listquotaworkloads),
[ListQuotas](https://help.aliyun.com/zh/pai/developer-reference/api-paistudio-2022-01-12-listquotas),
[DescribeMetricList](https://help.aliyun.com/en/cms/cloudmonitor-1-0/developer-reference/api-cms-2019-01-01-describemetriclist).
