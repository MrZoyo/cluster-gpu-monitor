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
| `ranking_timezone` | `Asia/Shanghai` | IANA timezone used by weekly boundaries, page timestamps and CSV |
| `ranking_week_start` | `monday` | First weekday: `monday` through `sunday`, lowercase |
| `ranking_reset_time` | `00:00` | Weekly rollover in local `HH:MM` (24-hour time) |
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
  submission policy and quota sharing. Borrowing stays inside owned capacity, with undisclosed donors;
  borrowed GPU counts are never added to the physical total.
- Queue guidance considers submission policy, quota capacity and per-pod specifications while preserving
  the scheduler's reason. Missing evidence does not justify a definite scheduling conclusion.
- Charts retain workload/pod/GPU dimensions and source timestamps in fixed 120-second buckets. Late points
  can revise buckets; gaps are not zero. Metrics remain available without a physical-node mapping, and
  current physical ownership is not backfilled into history.
- “Compute mean (tasks)” on home and overview averages the latest fresh compute metrics across GPUs in
  running tasks, with equal weight per GPU, including unmapped idle-time tasks. Unallocated GPUs and missing
  or stale values are excluded. This is not an equal-weight average of task averages.
- Pool GPU utilization is a monitored-workspace workload estimate over the owned physical capacity, including borrowing once.
  Hidden donors prevent treating unmapped cards as idle. It is not a complete per-card measurement of the whole tenant.

- Workload and user detail pages may retain last-successful stale metrics and mark them; the overview task
  mean uses fresh metrics only.
- Low-utilization cues use a ten-minute mean with at least five minute samples. Stale values remain visible
  but do not trigger that cue. CPU/RAM utilization is a percentage of the pod limit; requested amounts are separate.
- Attribution comes from RAM owners/submitters, not CloudMonitor's account-level `userId` or individual
  processes inside shared containers.
- GPU hours use workloads successfully read in the current round with status Running. Long gaps count at
  most twice the degraded interval; known zero scheduled GPUs remain zero. UTC-hour buckets retain 32 days;
  fractional boundaries are estimated by hourly overlap. These are observed estimates, not billing records.

### Weekly feature ranking

The default window runs from Monday 00:00 Beijing time (Asia/Shanghai) to now; last week is the
previous full configured reporting week. The timezone, weekday and rollover time are configurable. Rolling windows remain available. PAI window and dimension choices are
independent of bare-metal pages and survive automatic refresh. Features group workloads by the
`QuotaId` used at submission, so one user can appear under several features. Direct root-quota
submissions stay in their own row; the page never guesses an algorithm group from usernames. Weekly
reports per group therefore require submitters to choose the matching quota.

Configure the installed version in private `config/pai.toml`:

```toml
ranking_timezone = "Asia/Shanghai"
ranking_week_start = "monday"
ranking_reset_time = "00:00"
```

For example, `America/New_York`, `sunday`, `06:30` starts each week on Sunday at 06:30 New York time.
The next ranking request uses the updated rule, including historical queries; it does not erase history.
These fields control weekly rollover, not the page's 120-second auto-refresh or collector cadence.
Validate before applying with `GPUMON_ROOT=/path/to/runtime uv run python -c
'from gpumon.pai.config import load_pai_settings; load_pai_settings(); print("PAI config OK")'`.
Unknown zones, invalid weekdays and malformed times fail validation. Install the supporting version before
adding these fields. IANA timezone data is supplied by the system or the bundled `tzdata` dependency.

Weeks follow the local calendar across daylight-saving changes, so last week may contain 167 or 169 hours.
If the configured wall time does not exist during a spring-forward transition, it shifts forward by the gap;
if repeated during fall-back, its first occurrence is used. API fields `timezone`, `week_start`, `reset_time`
and CSV metadata state the rule; page dates and CSV local timestamps use that timezone.

History remains in UTC-hour buckets. If a boundary is not aligned to a UTC hour (including fractional-offset
zones), resource-seconds and metric sums/counts in that boundary bucket are apportioned by overlap duration.
This preserves additive totals between adjacent windows but cannot reconstruct within-hour starts, stops or
missing observations; job counts include jobs present in the overlapping bucket. `boundary_estimate=true`
flags this in the API and CSV. An ongoing hour is not discounted a second time. Exact hourly-aligned
boundaries, including the default, retain the existing accounting.

- **Task GPU hours** include regular and borrowed workloads; borrowing is a subset of the occupied total. A workload
  counts only toward its submission quota and is never added again to a parent quota.
- **Current quota / usage / occupancy** come from the latest quota snapshot and always describe now, even
  when last week is selected. A stale snapshot is flagged. Allocated GPUs and ancestor-quota allocations appear in the
  usage tooltip; they are not the feature's task usage.
- **Window quota occupancy** divides observed quota used GPU-seconds by capacity GPU-seconds over the same
  intervals, weighting quota changes by duration. It uses the platform's `gpu_used` counter, which may exclude borrowing within the pool. Parent usage can include children; neither capacity nor usage can be added across levels.
  Missing data, zero capacity or no historical denominator leaves occupancy unknown; current capacity is
  never used to reconstruct history.
- **Compute while occupied** divides effective GPU time by measured occupied GPU time and reports its coverage. Compute is not quota occupancy, and occupancy is not
  compute efficiency.
- Quota history starts at the first observation after this feature was deployed and integrates the previous
  snapshot (the quota catalog refreshes about every five minutes). The first observation is not backfilled,
  failed snapshots are not carried forward, and long gaps count at most twice the degraded interval. Pool
  coverage appears in the summary; a quota whose coverage differs clearly from the pool is marked in its row.
  With partial coverage, occupancy describes only observed intervals, and task history may be longer.
  Quota history is kept for 32 days with the same hourly boundaries as task rankings.
- The page opens with a window summary: occupied GPU hours, estimated pool GPU utilization, compute efficiency while occupied,
  current pool task occupancy and active features. “Near full” (window occupancy ≥ 90%) and “Low compute” (occupied-time compute efficiency
  < 10%) are cues only and do not change the order. Calculation notes are collapsed below the table.
- **CSV export** includes the window, generation time, task-history start, truncation flag and every returned
  row. Feature exports add capacity GPU hours, used GPU hours, observed hours, coverage and compute metrics
  for checking weekly reports. Unknown values are empty; exporting never sends reports or messages.

Pages refresh every 120 seconds while retaining scroll, filters and expanded sections; typing in the
search field postpones refresh. Source details include fetch times, sample times and failure categories.
Collection failure does not imply a failed cloud node, and no visible allocation does not guarantee
schedulable capacity. Health guidance never restarts DSW, stops DLC or changes cloud resources.

## Owned-pool borrowing and audit metrics

On 2026-10-10 this project aligned the owned-pool interpretation with provider confirmation:

- `UseOversoldResource` / oversold means temporarily borrowing unused nodes from other quotas in the owned pool.
  It adds neither physical GPU capacity nor additional GPU resource charges. Never add borrowed GPUs to pool capacity.
- The lending quota and node ownership are undisclosed. The owning quota always has priority; when reclaimed,
  the borrowing workload pauses, releases resources and requeues. Do not imply an extra compute pool or guaranteed permanent termination.
- Borrowed GPU time belongs to the **borrowing workload's submitting feature/user**, not an inferred donor team.
  Features follow submission Quota, users follow RAM owner/submitter; direct root submissions stay separate.
- Existing Quota `gpu_used` / `occupancy_pct` remain **quota accounting counters**, which can exclude borrowing.
  These counters are not physical pool occupancy or GPU compute utilization.

The audit separates three questions:

1. **Occupied GPU time:** `gpu_hours` integrates observed running scheduled GPUs, including borrowing once.
   Requested GPUs remain the fallback when scheduled counts are unavailable. `borrowed_gpu_hours` is a subset;
   legacy `oversold_gpu_hours` is an alias, not another amount to add. Queued/paused intervals do not accrue.
   After an observed pause or failed snapshot, missing fresh dequeue evidence means counting resumes only after the new observation.
2. **Compute while occupied:** each per-GPU compute sample represents 60 seconds.
   `measured_gpu_hours = min(occupied GPU-hours, compute sample count / 60)` within each workload/hour.
   `effective_gpu_hours` weights that measured time by compute utilization; `hardware_efficiency_pct` divides effective by measured time.
   `gpu_metric_coverage_pct` reports the measured share of occupied GPU time. Missing samples are neither zero nor extrapolated to a full hour.
   Legacy `compute_mean` remains a sample mean; audit tables use GPU-time-weighted efficiency.
   GPU busy percentage is not FLOPS or training throughput efficiency.
3. **Pool utilization over a period:** new `cluster` history integrates each observation with physical capacity counted once.
   `task_utilization_estimate_pct` is workspace effective GPU time / physical pool capacity GPU time over the same valid intervals.
   `task_occupancy_pct` is occupied GPU time / capacity over those intervals. Borrowing contributes usage without adding capacity.
   This estimate covers the configured workspace; undisclosed workloads of other workspaces are not in its numerator.
   `task_estimate_coverage_pct` reports the observed share of the selected window in the page and CSV.

Cluster history starts when this audit feature is enabled, retains 32 days and never backfills past capacity from today's state.
`physical_utilization_pct` is available only when all physical card states/compute are known; unmapped borrowing remains unknown.
`physical_metric_coverage_pct` reports confirmed capacity-time coverage. Cluster estimates and per-feature/user metrics can cover different
intervals, so compare their coverage too. CSV carries `cluster_*` metadata and per-row occupied/borrowed time, efficiency and coverage.

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

`current_ancestor_allocated_gpu` is the ancestor allocation counter, not the hidden idle-time donor mapping.
`current_borrowed_gpu` remains a legacy API alias for that counter; CSV uses the explicit name.
