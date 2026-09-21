# Protection for slow GPU queries

[简体中文](ADAPTIVE_PROBING.md) | English

A host that remains reachable while `nvidia-smi` stalls stays online. Its status becomes
“Suspected overload · slow GPU response”. This describes collection behavior; it does not prove
multi-user contention or diagnose the driver.

## States and presentation

| health | Meaning |
| --- | --- |
| `online` | Recent host heartbeat and normal GPU collection |
| `overloaded` | Host reachable; GPU query slow, timed out, blocked by an earlier query, or recovering |
| `gpu_error` | Host reachable; explicit GPU error or interrupted query response |
| `offline` | Collection attempts continue, but the host heartbeat has expired |
| `unknown` | Collection attempts themselves have expired, or no observations exist |
| `inactive` | An inactive host in the summary API |

The overview, cluster, host and GPU pages and summary API share these states. Overloaded hosts
have a subtle orange breathing border and static card stripes. Recovery has its own label.
Reduced-motion settings disable animation. Tooltips show the effective query interval and last
valid observation; the host detail page also displays this explanation directly.

Offline host labels include a duration, such as “Offline for 2h 15m”, updated on each page refresh.
The estimate starts at the last successful host heartbeat, falling back to the last complete sample
for older data without a heartbeat. Missing or invalid timestamps show “Offline · duration unknown”.
This is not the exact failure time. GPU degradation, planned hosts and unknown monitoring status
do not display an offline duration.

The “Overload / Delay” legend uses an 18×18px swatch with the same yellow border and stripes.
At widths up to 1180px, header controls move to another row. Phones show online counts and data age
on separate lines. Long breadcrumbs truncate with their full text on hover, preserving room for status.

A failed GPU query makes current utilization null. While the host remains online, cards can
show the recent utilization from its last complete sample for up to 180 seconds while keeping the
average below it. Yellow borders and stripes provide the status cue, explained by “Overload / Delay”
in the utilization legend. The tooltip gives the last sample time. After that limit, or when the host goes offline, the fallback
is hidden. `last_sample.util_recent` serves this display only and does not enter current statistics.
Unknown cards contribute to `cards_unknown`, not `cards_idle`. If only process
collection fails, completed GPU metrics remain valid, while process data is marked unavailable.

## Settings and timing

Old configuration files receive these defaults in `[collector]`:

```toml
ssh_connect_timeout_s = 15
gpu_slow_s = 15
gpu_timeout_s = 20
gpu_backoff_s = 60
gpu_recover_s = 10
gpu_recover_count = 2
```

SSH connections can take up to 15 seconds to tolerate brief network delays.
A GPU phase taking at least 15 seconds, a timeout or a collection error activates cooldown only
for that host. Subsequent GPU query starts are at least `max(poll_interval_s,gpu_backoff_s)` seconds
apart. Host heartbeats continue at `poll_interval_s`, normally 30 seconds. A due GPU query shares
that heartbeat's SSH connection. Two consecutive valid queries taking less than ten seconds
restore the normal interval; another slow/failed attempt resets the recovery streak.

Configuration requires `gpu_recover_s < gpu_slow_s <= gpu_timeout_s`. Cooldown, recovery count and
confirmed vendor survive collector restarts. Review explicitly configured thresholds when upgrading.
Scheduling uses a monotonic clock while running and
never catches up missed queries.

The GPU timeout covers detection, metrics and process collection together. Remote termination uses
TERM followed by KILL after two seconds. The outer SSH deadline is
`max(ssh_total_timeout_s,ssh_connect_timeout_s+cpu_sample_gap_s+gpu_timeout_s+5)`, or 41 seconds with
defaults. Heartbeat-only rounds omit the GPU budget. This lets the remote timeout report its result
before the SSH client exits. Heartbeats and collection attempts expire after
`max(120,4*poll_interval_s)` seconds. A stopped collector yields unknown, not fleet-wide offline.

Each host has at most one collector task. Completed hosts are persisted immediately. Global SSH,
output-byte and parsed-object limits remain enforced. Many slow hosts can still occupy all global
slots and delay other starts; the collector does not bypass those resource limits.

## Remote dependencies and locking

Targets need Bash, GNU coreutils including `timeout`, `ps`, and util-linux `flock`. Missing tools
produce a GPU collection error while preserving the host heartbeat. No packages are installed
automatically.

The script runs through stdin. It retains only a private `gpu-probe.lock` file under
`${XDG_RUNTIME_DIR:-/tmp}/gpumon-$UID/`, owned by the collection account with directory mode 0700.
No scripts or telemetry are stored. Query processes inherit the lock descriptor: if an earlier
call has not exited, a later probe skips GPU collection instead of stacking another `nvidia-smi`.
Do not delete that file or directory while an earlier query remains alive.

Normal NVIDIA collection makes two SMI calls: GPU metrics and compute processes. PID mapping reuses
the process output. Initial detection may make an extra call until a vendor is confirmed and cached.
Set `vendor: nvidia` when known; update inventory after changing hardware vendors.

## Sampling and history

Only real GPU observations receive weights. A weight is the planned interval at dispatch, capped
by the time since the preceding valid GPU observation. Failed and heartbeat-only rounds create
no GPU/process samples and do not extend a weight across failures. This is a sampling estimate,
not proof that a process occupied a GPU continuously between observations.

Recent means, rollups, historical means and GPU hours use these weights. Each metric retains its
own valid weight, excluding N/A values; raw sample count `n` is preserved. Coverage retains the
full denominator of expected inventory GPUs multiplied by window duration. Processes are first
deduplicated by username/GPU/sample; shared GPUs still count for each user without splitting time.
Existing API rounding is preserved.

Legacy samples and rollups without weights use the configured legacy interval. Historical data
is not backfilled or rewritten. GPU hours remain a trend estimate and failed rounds can undercount.

## Upgrade and rollback

Back up the database and configuration. Run `gpumon initdb` with the new code before starting the
new read-only Web service, then start the new collector/Web release. Upgrades from v0.4.0 or older
idempotently add two tables and nullable rollup columns, with no historical backfill or existing-index rebuild.
Upgrading from v0.5.0 to v0.5.1 requires no additional schema changes.
The private deployment workflow backs up first, applies the additive schema, then validates both
the new Web and the rollback version before switching.

Remove the five GPU configuration keys before rolling back to v0.4.0 or older, if they were
explicitly added. Extra database tables/columns may remain. Older statistics code ignores adaptive
weights, so cross-version comparisons must account for its fixed-interval estimates.

## Local verification

```bash
uv run pytest -q tests/test_adaptive_probe.py tests/test_adaptive_metrics.py
uv run pytest -q
node tests/frontend_security.js
```

Local fake SMI tools exercise timeouts, process failures, lock conflicts, transport interruptions,
persistent cooldown, recovery, independent host scheduling, and weighted statistics. They do not
connect to real GPU nodes. The generated demo includes synthetic slow, timed-out, recovering and
offline hosts using the real UI state paths.
