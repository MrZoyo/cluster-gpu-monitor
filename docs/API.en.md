# Recent GPU utilization API

[简体中文](API.md) | English | [Documentation index](README.en.md)

`GET /api/v1/gpu-summary` returns recent utilization for all non-retired hosts in one
JSON response. It accepts no query parameters. Operators can make this one GET
endpoint anonymous; the default authenticated reverse proxy still protects it.

```bash
curl --fail-with-body --silent --show-error --max-time 15 \
  "https://YOUR_MONITOR_DOMAIN/api/v1/gpu-summary"
```

The response contains `as_of` (cached computation time, Unix epoch seconds) and
`hosts`. Each host has `name`, `model`, `online`, `sampled_at`, and a
`util_pct` array. Array positions normally correspond to zero-based GPU indices;
when indices are not contiguous, an additional `indices` array identifies each
position explicitly.

A shared GPU model or sampling time is returned once per host. If the values
differ, `model` or `sampled_at` becomes an array aligned with `util_pct`,
preserving nulls for unknown values. Utilization precision is unchanged; integral
values are encoded as integers. The 600-second window and 30-second cache are
fixed, so these constants are documented rather than repeated in every response.

```json
{
  "as_of": 1788850000,
  "hosts": [{
    "name": "Node A",
    "model": "Example GPU",
    "online": true,
    "sampled_at": 1788849980,
    "util_pct": [0, 82.5, null]
  }]
}
```

Utilization uses the same function as the dashboard: the mean of valid samples
from the last 600 seconds, with an immediate reset to zero when the last three
valid samples are all at most 5%. This is utilization, not free memory or a
guarantee that a GPU can be allocated.

A host is online only when active and successfully sampled within 120 seconds.
GPU samples must also be no older than `max(120, 4 * poll_interval_s)` seconds.
Offline, stale, missing, and inactive GPU readings are `null`, not zero.
Freshness is checked on every response, including cache hits. Expected but
undetected GPU slots remain present as unknown; retired hosts follow the same
topology exclusion as the dashboard.

The output is an explicit field allowlist. It omits users, processes, memory,
SSH aliases, addresses, hardware UUIDs, notes, and error details. Display names
and GPU models are public information when anonymous access is enabled.

## Enable or disable

Configure `config/settings.toml`:

```toml
[web]
enable_gpu_summary = true
```

The default is `true`, including legacy configurations that omit the field.
Set it to `false` and restart Web to return HTTP 404 without reading or serving
the summary cache or executing summary queries. Other APIs and the dashboard are
unaffected. Native deployments can use `systemctl restart gpumon-web`; restart
the Web service for container deployments.

This controls application availability. The reverse proxy still controls
anonymous external access; an anonymous proxy exception returns only 404 while
the feature is disabled. Configuration failures return generic 503, including
when a cache is warm.

Only the path `/api/v1/gpu-summary` is fixed in code. Operators choose the domain;
replace `YOUR_MONITOR_DOMAIN` with the deployment's own domain.

Before rolling back from v0.4.0 to a version without this setting, restore the
previous settings backup or remove the new field. Older versions reject unknown
configuration fields.

## Python client

Set a descriptive User-Agent; some Cloudflare deployments reject Python's default
User-Agent. This example connects directly, for environments that do not require
an HTTP proxy:

```python
import json
import urllib.request

request = urllib.request.Request(
    "https://YOUR_MONITOR_DOMAIN/api/v1/gpu-summary",
    headers={"User-Agent": "gpu-monitor-agent/1.0", "Accept": "application/json"},
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(request, timeout=15) as response:
    summary = json.load(response)
print(summary)
```

Honor `Retry-After` for 429/503. A 403 from an upstream proxy or edge policy is
different from the application's rate limit; verify the deployed client's proxy
configuration and User-Agent.

## Cache and rate limit

All clients share one in-process snapshot for up to 30 seconds. Refresh reads
topology, indexed GPU timestamps, recent utilization, and collector status; it
does not query processes or long-term aggregates. Concurrent refreshes coalesce.
HTTP caching is disabled so every request reaches the limiter.

Each source IP can receive at most one successful response every 10 seconds.
An early retry gets HTTP 429 and `Retry-After` with the remaining wait. Rejections
do not extend the cooldown. Agents behind the same public IP share a quota.
IPv4-mapped IPv6 addresses share the equivalent IPv4 quota.

A failed refresh, a wait longer than one second, or a full table of 4096 active
IP entries returns generic HTTP 503 and `Retry-After: 10`. Failures do not consume
a successful-request quota and never fall back to an expired snapshot.
Unknown parameters return 400; non-GET methods return 405, unless the proxy first
requires authentication.

The limiter and cache belong to the single `gpumon web` process and reset on
restart. Do not run multiple independent workers for this endpoint without a
shared limiter. Clients should normally poll at the collection interval and
honor `Retry-After` on 429/503.

## Optional anonymous access

Deploy the endpoint code first. Import
[public-summary.caddy](../deploy/caddy/public-summary.caddy) outside the Caddy site
block, after any global options, and update the site as follows:

```caddyfile
import /etc/caddy/public-summary.caddy

YOUR_MONITOR_DOMAIN {
    import gpumon_summary_access
    basic_auth @gpumon_private {
        team {$GPUMON_BASIC_HASH}
    }
    import gpumon_summary_proxy
}
```

Preserve existing TLS, security headers, logs, and `Cache-Control: no-store`.
Use `basicauth` on Caddy 2.6/2.7. Only the exact GET path is exempt; the dashboard
and other APIs retain authentication.

The snippet assumes a native deployment on `127.0.0.1:8848`. It overwrites
caller-provided forwarding headers, accepts `CF-Connecting-IP` only from a TCP
peer in Cloudflare's listed ranges, and forwards one canonical client IP.
The CLI trusts proxy headers only from loopback. Keep the backend inaccessible
externally; validate other proxy topologies separately. Update the ranges when
Cloudflare's official IPv4/IPv6 lists change.

Any Cloudflare policy must allow ordinary HTTP clients to reach this exact
endpoint while retaining suitable edge traffic protection. Its rate counters
can lag; the application enforces the 10-second interval. Verify 200, immediate
429, recovery after `Retry-After`, authentication on other paths, and resistance
to spoofed forwarding headers. Use bounded, serial production checks.

Anonymous access lets anyone repeatedly retrieve this summary. Public code and
examples contain no deployment credentials, actual domains, or private topology.
