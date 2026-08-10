# Deployment Guide

Install cluster-gpu-monitor on a machine that stays online (hereinafter **monitor host**). It polls each GPU node via SSH and runs a web service for your team. Target nodes **install nothing** and need no root access.

Placeholders in this guide, replace per your environment:

| Placeholder | Meaning |
| --- | --- |
| `<SERVER_IP>` | Monitor host IP (internal or public) |
| `<YOUR_DOMAIN>` | Your domain, e.g. `gpu.example.com` |
| `<ROOT>` | Code directory, examples use `/opt/gpu-monitor` |
| `<USER>` | System account running the service, examples use `gpumon` |
| `<BASTION>` | SSH alias of bastion host |
| `<YOUR_SUBNET>` | Allowed access subnet, e.g. `10.10.0.0` |

---

## 0. Three Access Paths, Pick One

All three are supported, choose based on what you have:

| Path | Suitable for | Encryption | Complexity |
| --- | --- | --- | --- |
| **1. IP + HTTP direct** | Internal network, testing, solo use | None (plaintext) | One command |
| **2. Domain + Caddy auto HTTPS** | Production recommended | Trusted cert, green lock | Two lines of config |
| **3. No domain → DuckDNS + DNS-01** | No domain, or inbound 80/443 blocked | Trusted cert, green lock | Needs Caddy with plugin |

Sections 1, 2, 3 are common prep for all paths, do them then jump to section 5 to pick your path.

---

## 1. Prerequisites

Monitor host:

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (for dependencies / virtual env)
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  ```
- Passwordless SSH access (key-based auth) to **every** target GPU node
- System `ssh` command (collector calls it directly, not paramiko, to reuse `~/.ssh/config`)

Target GPU nodes:

- **Install nothing.** No agent, no daemon, no files written. Collector script is piped via `ssh <alias> bash -s` from stdin, runs in remote memory and vanishes.
- Regular user account sufficient, **no root needed**. Account just needs to run `nvidia-smi` (or `rocm-smi` / `amd-smi`) and `ps`, read `/proc/stat` and `/proc/meminfo` — all open to regular users by default.
- Requires `bash` and coreutils, basically "is a Linux machine."

---

## 2. SSH Configuration: Foundation of Entire Deployment

By design, **no IPs, ports, or key paths appear in code**. `inventory.yaml` only has SSH aliases, real network topology lives in `~/.ssh/config`. This indirection brings two benefits used later.

First create a dedicated key (don't use your personal key for services):

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519_gpumon -C 'gpumon@monitor-host'
cat ~/.ssh/id_ed25519_gpumon.pub   # Distribute this public key
```

Append public key to `~/.ssh/authorized_keys` on each target node (`ssh-copy-id` is easiest):

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_gpumon.pub <user>@<node-addr>
```

Then write `~/.ssh/config`:

```sshconfig
# Global defaults
Host *
    IdentityFile ~/.ssh/id_ed25519_gpumon
    ServerAliveInterval 15
    ServerAliveCountMax 3

# --- Direct nodes (same datacenter / routable) ---
Host node-a1
    HostName <NODE_A1_ADDR>
    User <REMOTE_USER>

Host node-a2
    HostName <NODE_A2_ADDR>
    User <REMOTE_USER>

# --- Bastion itself ---
Host <BASTION>
    HostName <BASTION_ADDR>
    User <BASTION_USER>
    Port 22

# --- Nodes behind bastion: ProxyJump one line ---
# ssh first connects to <BASTION>, then from bastion connects to node-b1, all in one command, one auth chain.
Host node-b1
    HostName <NODE_B1_INTERNAL_ADDR>
    User <REMOTE_USER>
    ProxyJump <BASTION>

# Multi-hop bastion: comma-separate ProxyJump <BASTION>,<BASTION2>
```

> Bastion also needs this public key (`authorized_keys`) for relay. ProxyJump just forwards TCP, collector script still executes on final node, bastion needs no GPU or installation.

**Verify collection works on every host**, don't proceed without passing this:

```bash
for a in node-a1 node-a2 node-b1; do
  printf '%-12s ' "$a"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$a" 'nvidia-smi -L | head -1' || echo FAIL
done
```

Each line should return `GPU 0: NVIDIA ...`. `BatchMode=yes` is critical: disables all interactive prompts, if it asks for password the key isn't set up, and after becoming a service it will silently hang.

**Why this indirection is worth it**:

1. **Migrating monitor host only requires rewriting ssh config.** `key` in `inventory.yaml` is the stable anchor for historical data. When changing machines, IPs/bastions behind `ssh_alias` can change however they want, as long as `key` stays unchanged, historical curves and stats stay continuous — database links by `key`, not address.
2. **Node IP changes, adding bastion, using proxy, all need no code changes, no DB rebuild.** Just edit ssh config.

---

## 3. Install Application

```bash
sudo mkdir -p <ROOT> && sudo chown <USER>:<USER> <ROOT>
# Pull code (or rsync from local)
git clone <REPO_URL> <ROOT>
cd <ROOT>

cp config/inventory.example.yaml config/inventory.yaml
cp config/settings.example.toml  config/settings.toml

uv sync                 # Create .venv and install dependencies
uv run gpumon config-check   # Validate config, print parsed clusters/hosts/GPU counts
```

Edit `config/inventory.yaml`, replace example clusters with your real machines — `ssh_alias` must **exactly match** aliases in previous section's `~/.ssh/config`. Field meanings are commented line-by-line in example file, key points:

- `key` once online **never change**, it's the link key for historical data
- `gpu_count` is expected count, used for "missing GPU" detection
- `vendor` leave empty for auto-detection (nvidia → amd), usually no need to write

In `config/settings.toml`, commonly adjusted: `poll_interval_s` (default 30s), `max_concurrency` (concurrent SSH count, increase for many nodes), retention days, `[web]` listen address and port.

Create DB + try one collection round:

```bash
uv run gpumon initdb
uv run gpumon collect --once     # One round, prints success/failure per host
```

If round completes showing "success N/N hosts" you're through. Single-host troubleshooting use `uv run gpumon collect --once --host <host-key>`, raw probe output use `scripts/probe_one.sh <ssh-alias>`.

---

## 4. Install as systemd Service

Repo has four unit templates, all use `__ROOT__` / `__USER__` placeholders, replace with `sed` then deploy:

| File | Type | Notes |
| --- | --- | --- |
| `deploy/systemd/gpumon-collector.service` | User-level | No `User=`, runs as current login user |
| `deploy/systemd/gpumon-web.service` | User-level | Same |
| `deploy/systemd/system-gpumon-collector.service` | System-level | Has `User=__USER__`, auto-start on boot |
| `deploy/systemd/system-gpumon-web.service` | System-level | Same |

**System-level (use this for server deployment)**:

```bash
ROOT=<ROOT>
for u in collector web; do
  sed "s#__ROOT__#$ROOT#g; s#__USER__#<USER>#g" \
    "$ROOT/deploy/systemd/system-gpumon-$u.service" \
    | sudo tee "/etc/systemd/system/gpumon-$u.service" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now gpumon-collector gpumon-web
systemctl status gpumon-collector gpumon-web --no-pager
```

**User-level (for trying on your own machine)**: No sudo needed, but SSH agent / keys are under your own account, and **stops on logout** by default.

```bash
ROOT=<ROOT>
mkdir -p ~/.config/systemd/user
for u in collector web; do
  sed "s#__ROOT__#$ROOT#g" "$ROOT/deploy/systemd/gpumon-$u.service" \
    > ~/.config/systemd/user/gpumon-$u.service
done
systemctl --user daemon-reload
systemctl --user enable --now gpumon-collector gpumon-web
# To keep running after logout:
sudo loginctl enable-linger $USER
```

Difference: system-level uses `User=` to specify account, `WantedBy=multi-user.target`, starts on boot, doesn't depend on login session; user-level managed by `systemctl --user`, logs via `journalctl --user`. **Don't enable both** — two collectors writing same SQLite will fight for write lock.

`Environment=GPUMON_ROOT=<ROOT>` is mandatory: all relative paths (database, config, web static files) resolve from this root.

---

## 5. Path 1: IP + HTTP Direct (Simplest)

Fastest way to see the UI. Edit `config/settings.toml`:

```toml
[web]
host = "0.0.0.0"
port = 8848
```

Or temporary command-line override:

```bash
uv run gpumon web --host 0.0.0.0 --port 8848
```

Browser open `http://<SERVER_IP>:8848`.

> **Warning: Plaintext transmission.**
>
> This is **pure HTTP, no encryption**. Future login page passwords would also transmit plaintext, same network segment packet capture can grab them; page content (who's using which GPU) also plaintext.
>
> **Only use on networks you trust** (lab intranet, office LAN, inside company VPN).
>
> Additionally, `--host 0.0.0.0` means **anyone who can reach this port can access**, no network-layer filtering. This path's access control **only relies on application's own login page** — and current version has no login page yet, meaning this path equals "whoever connects can view." So must rely on firewall to narrow source:
>
> ```bash
> # Only allow access from certain subnet to 8848 (example, change per your subnet)
> sudo ufw allow from <YOUR_SUBNET>/24 to any port 8848 proto tcp
> ```
>
> If this machine has public IP, **do not** use this path for external exposure, use path 2 or 3.

Only want to view yourself, don't want to open any port? SSH port forwarding is cleanest, backend stays `127.0.0.1`:

```bash
# Execute on your laptop, then access http://127.0.0.1:8848
ssh -N -L 8848:127.0.0.1:8848 <monitor-host>
```

---

## 6. Path 2: Domain + Caddy Auto HTTPS (Production Recommended)

Backend **returns to** `127.0.0.1`, only Caddy faces external, TLS and auth all done at Caddy.

```toml
# config/settings.toml
[web]
host = "127.0.0.1"
port = 8848
```

### 6.1 DNS

Point `<YOUR_DOMAIN>` A record to monitor host public IP, wait for propagation:

```bash
dig +short <YOUR_DOMAIN>
```

### 6.2 Install Caddy

```bash
# Debian / Ubuntu official repo
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 6.3 Password Hash via Environment Variable

```bash
caddy hash-password --plaintext '<your strong password>'      # Output $2a$14$...

sudo mkdir -p /etc/gpumon
sudo tee /etc/gpumon/caddy.env >/dev/null <<'EOF'
GPUMON_BASIC_HASH='<paste hash from above>'
EOF
sudo chmod 600 /etc/gpumon/caddy.env
```

`GPUMON_BASIC_HASH` **must use single quotes**, bcrypt hash contains `$`, without quotes shell expands it as variable, resulting in corrupted hash, symptom is "password never matches."

Let Caddy read this file:

```bash
sudo systemctl edit caddy      # Write following three lines
# [Service]
# EnvironmentFile=/etc/gpumon/caddy.env
```

### 6.4 Caddyfile

Core is two lines — domain + reverse proxy, certificate handled by Caddy automatically:

```caddyfile
<YOUR_DOMAIN> {
	basic_auth {
		team {$GPUMON_BASIC_HASH}
	}
	reverse_proxy 127.0.0.1:8848
	log {
		output file /var/log/caddy/gpumon.log
	}
}
```

Full commented template see `deploy/caddy/Caddyfile.example`.

> Directive name by version: Caddy ≥ 2.8 is `basic_auth`, 2.7 and earlier is `basicauth`. Check with `caddy version`.

```bash
sudo cp deploy/caddy/Caddyfile.example /etc/caddy/Caddyfile
sudo vim /etc/caddy/Caddyfile          # Fill <YOUR_DOMAIN>
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy && sudo systemctl reload caddy
```

First Caddy start automatically requests certificate from Let's Encrypt and configures auto-renewal, nothing to manage. Prerequisite is **inbound 80 and 443 both reachable**: 80 for HTTP-01 challenge and HTTP→HTTPS redirect, 443 is actual service. Cloud VM remember to allow 80/443 in security group, **8848 absolutely do not allow**.

Verify:

```bash
curl -I https://<YOUR_DOMAIN>/                              # Expect 401 (no credentials)
curl -u 'team:<your password>' https://<YOUR_DOMAIN>/api/health   # Expect {"ok":true,...}
```

---

## 7. Path 3: No Domain? Use DuckDNS + DNS-01

[DuckDNS](https://www.duckdns.org/) is a free dynamic DNS, gives you a `<YOUR_SUBDOMAIN>.duckdns.org` subdomain. Combined with **DNS-01** challenge, you can get browser-trusted certificate — **without needing any inbound port access**.

### 7.1 Why DNS-01 (This is Most Valuable)

ACME certificate signing needs to prove "this domain is yours", three challenge methods:

| Challenge | Proof method | Requirements |
| --- | --- | --- |
| HTTP-01 | Put a file at `:80` for CA to fetch | **Inbound 80 must be reachable** |
| TLS-ALPN-01 | Special TLS handshake at `:443` | **Inbound 443 must be reachable** |
| **DNS-01** | Write a TXT record in DNS | **Only need outbound access to DNS provider API** |

DNS-01 is entirely the monitor host actively calling DuckDNS HTTP API to write TXT record, CA queries DNS, **no step requires external connection into your machine**.

This saves several common困境situations:

- Cloud provider / datacenter / ISP **blocks inbound 80, 443** (home broadband, some regional compliance restrictions very common)
- Machine behind NAT, can't do port mapping
- You simply don't want to open 80/443, only want a non-standard port

Use non-standard port externally (like 8443), 80/443 blocked doesn't matter, green lock still works.

> Compliance reminder: Some regions/countries require filing or licensing for web services on domains, unfiled domains may be intercepted by middleboxes on 80/443. This is local regulation issue, changing ports doesn't solve compliance, only connectivity.

### 7.2 Register DuckDNS

1. Open https://www.duckdns.org/, login with GitHub / Google / other third-party account
2. In `domains` input box fill desired name, click **add domain**, get `<YOUR_SUBDOMAIN>.duckdns.org`
3. Top of page has a **token** line, copy it (this is API credential, like password, don't leak)
4. Point subdomain to monitor host (browser directly accessing below URL also works, returns `OK` on success):

```bash
curl "https://www.duckdns.org/update?domains=<YOUR_SUBDOMAIN>&token=<TOKEN>&ip=<SERVER_IP>"
# Leave ip= empty to use your current outbound IP, suitable for dynamic IP:
# curl "https://www.duckdns.org/update?domains=<YOUR_SUBDOMAIN>&token=<TOKEN>&ip="
```

If IP changes, add cron to refresh periodically:

```bash
# crontab -e
*/5 * * * * curl -fsS "https://www.duckdns.org/update?domains=<YOUR_SUBDOMAIN>&token=<TOKEN>&ip=" >/dev/null
```

### 7.3 Install Caddy with duckdns Plugin

DNS-01 needs Caddy to call DNS provider API, official prebuilt binaries **do not include** these plugins, need to bring your own. Three methods, pick one:

```bash
# Method A: Official download site custom build (easiest, no Go needed)
sudo curl -L -o /usr/local/bin/caddy \
  "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/duckdns"
sudo chmod +x /usr/local/bin/caddy
/usr/local/bin/caddy version

# Method B: xcaddy self-compile (needs Go 1.22+, controllable, reproducible)
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/duckdns
sudo install -m755 ./caddy /usr/local/bin/caddy

# Method C: Already installed official via apt — add plugin in place (pulls latest and reinstalls binary)
sudo caddy add-package github.com/caddy-dns/duckdns
sudo systemctl restart caddy
```

Regardless of method, **must confirm plugin is really inside after installing**, don't skip this step:

```bash
caddy list-modules | grep dns.providers
# Expect to see dns.providers.duckdns
```

No output means plugin didn't get compiled in, DNS-01 will keep failing on "cannot find dns provider". Methods A/B install to `/usr/local/bin/caddy`, while apt version unit points to `/usr/bin/caddy` — if path changed remember `sudo systemctl edit caddy` to modify `ExecStart`, or directly overwrite `/usr/bin/caddy`.

### 7.4 Configuration

Token also goes to environment file, don't write in Caddyfile:

```bash
sudo tee -a /etc/gpumon/caddy.env >/dev/null <<'EOF'
DUCKDNS_TOKEN='<your duckdns token>'
EOF
sudo chmod 600 /etc/gpumon/caddy.env
```

Caddyfile:

```caddyfile
<YOUR_SUBDOMAIN>.duckdns.org:8443 {
	tls {
		dns duckdns {env.DUCKDNS_TOKEN}
		# Explicitly specify resolvers, bypass local DNS cache causing TXT validation failure
		resolvers 1.1.1.1 8.8.8.8
	}
	basic_auth {
		team {$GPUMON_BASIC_HASH}
	}
	reverse_proxy 127.0.0.1:8848
	log {
		output file /var/log/caddy/gpumon.log
	}
}
```

```bash
sudo systemctl restart caddy
sudo journalctl -u caddy -f          # Watch certificate signing process, usually 10~60 seconds
```

Access `https://<YOUR_SUBDOMAIN>.duckdns.org:8443`. Security group only needs to allow 8443.

Different DNS provider just change plugin and directive name, pattern completely same:

| DNS Provider | Plugin | Caddyfile |
| --- | --- | --- |
| Cloudflare | `github.com/caddy-dns/cloudflare` | `dns cloudflare {env.CF_API_TOKEN}` |
| DuckDNS | `github.com/caddy-dns/duckdns` | `dns duckdns {env.DUCKDNS_TOKEN}` |
| Others | See https://github.com/caddy-dns | Same-name directive |

### 7.5 What If Domain Gets SNI Blocked

Extreme case: TCP connects but TLS handshake gets RST immediately (`curl` reports `Connection reset by peer` at handshake stage). This is usually middlebox blocking by **SNI** (domain carried plaintext in TLS handshake) — domains like `duckdns.org` free dynamic DNS have been targeted on some routes.

Workaround: **Add an IP direct-connect entry**. Browser accessing by IP has TLS handshake **without SNI**, middleboxes have no matchable domain.

```caddyfile
# Must be at very top of file: connections without SNI default to below IP site
{
	default_sni <SERVER_IP>
}

# Domain entry (green lock) — people who can access use this
<YOUR_SUBDOMAIN>.duckdns.org:8443 {
	tls {
		dns duckdns {env.DUCKDNS_TOKEN}
		resolvers 1.1.1.1 8.8.8.8
	}
	basic_auth { team {$GPUMON_BASIC_HASH} }
	reverse_proxy 127.0.0.1:8848
	log { output file /var/log/caddy/gpumon.log }
}

# IP fallback entry (self-signed, browser first-time warning click continue, traffic still TLS encrypted)
https://<SERVER_IP>:8443 {
	tls internal
	basic_auth { team {$GPUMON_BASIC_HASH} }
	reverse_proxy 127.0.0.1:8848
	log { output file /var/log/caddy/gpumon.log }
}
```

Without `default_sni`, connections without SNI will have Caddy unable to find matching site and directly refuse handshake — this is its entire reason for existence.

Two entries can coexist sharing same port: people who can normally access domain use green lock, others use IP entry. Self-signed certificate has warning but **link is still full TLS**, password won't transmit plaintext, much safer than path 1.

When completely no usable public entry, use `cloudflared` type outbound tunnel, or have team use SSH port forwarding.

---

## 8. Daily Operations

### After Changing inventory.yaml

**Adding machines**: Add entry under corresponding cluster's `hosts` + add alias in `~/.ssh/config` and distribute public key, then:

```bash
sudo systemctl restart gpumon-collector      # Collector only reads inventory at startup
```

Web will automatically show new machine, zero code changes. Before adding, verify SSH works:

```bash
sudo -u <USER> ssh -o BatchMode=yes -o ConnectTimeout=10 <new-alias> 'nvidia-smi -L'
```

**Retiring machines**: **Don't delete entry**. Deleting config while DB history rows remain causes web to hang perpetually offline ghost cards. Mark host or entire cluster `status: retired`, then restart both services:

```bash
sudo systemctl restart gpumon-collector gpumon-web
```

Collector immediately stops probing (no more connection failures accumulating), web completely hides the host, DB rows and historical samples preserved for auditing.

**Changed settings.toml**: Restart corresponding service (`[collector]` changed restart collector, `[web]`/`[privacy]` changed restart web).

**Only changed files under `web/`**: No restart needed. Static files are read fresh on each request, refresh page takes effect.

### Logs

```bash
# System-level
sudo journalctl -u gpumon-collector -f            # Per-round collection summary, failure reasons
sudo journalctl -u gpumon-web -f                  # HTTP access log
sudo journalctl -u caddy -f                       # Certificate signing, TLS errors
sudo journalctl -u gpumon-collector --since '1 hour ago' | grep -i fail

# User-level
journalctl --user -u gpumon-collector -f

# Caddy access log (JSON lines)
sudo tail -f /var/log/caddy/gpumon.log
```

### Health Check

```bash
curl -fsS http://127.0.0.1:8848/api/health
# {"ok":true,"last_sample_ts":1234567890,"last_sample_age_s":18}
```

`last_sample_age_s` should fluctuate around `poll_interval_s`. Consistently greater than two or three cycles means collector is down or all SSH failed.

```bash
curl -fsS http://127.0.0.1:8848/api/collector/status | python3 -m json.tool
```

One entry per host, look at these fields:

| Field | Meaning |
| --- | --- |
| `online` | Successfully collected within last 120 seconds |
| `gpus_seen` / `gpus_expected` | Actually detected GPU count / expected count in inventory |
| `consec_fail` | Consecutive failure count, 0 = last round succeeded |
| `last_error` | Last failure reason (SSH timeout, command not found, etc.) |
| `last_ok_ts` / `last_try_ts` | Last success / last attempt timestamp |

One command to list all unhealthy hosts:

```bash
curl -fsS http://127.0.0.1:8848/api/collector/status \
  | python3 -c 'import json,sys; [print(h["key"], h["gpus_seen"], "/", h["gpus_expected"], h["last_error"]) for h in json.load(sys.stdin)["hosts"] if not h["online"] or h["gpus_seen"] != h["gpus_expected"]]'
```

End-to-end self-test script (collect one round + aggregate + hit all endpoints):

```bash
./scripts/verify_e2e.sh
```

### Change Access Password

```bash
caddy hash-password --plaintext '<new password>'
sudo vim /etc/gpumon/caddy.env       # Update GPUMON_BASIC_HASH (remember single quotes)
sudo systemctl restart caddy         # Changed EnvironmentFile needs restart, reload won't reread
```

### Backup

Database is single-file SQLite, WAL enabled. **Direct `cp` is unsafe**, use SQLite online backup:

```bash
sqlite3 <ROOT>/data/gpumon.db ".backup '/backup/gpumon-$(date +%F).db'"
```

No `sqlite3` command-line? Use Python backup API:

```bash
cd <ROOT> && .venv/bin/python -c "
import sqlite3
src = sqlite3.connect('data/gpumon.db')
dst = sqlite3.connect('/backup/gpumon.db')
src.backup(dst); dst.close(); src.close()
print('ok')"
```

Database is single-writer model. Before any offline DB operations first `systemctl stop gpumon-collector` to avoid write contention.

### Migrating to New Monitor Host

Historical data can continue seamlessly because everything links by `key` in `inventory.yaml`, independent of address:

1. Complete sections 1~4 on new machine
2. Rebuild `~/.ssh/config` on new machine (keep alias names same, `HostName`/`ProxyJump` change per new network position)
3. Old machine `systemctl stop gpumon-collector`, use backup command above to generate consistent snapshot
4. Copy snapshot to new machine as `data/gpumon.db`
5. Start new machine services, confirm `/api/collector/status` all green
6. Stop and disable old machine services (`systemctl disable --now`)

---

## 9. Security Checklist

- [ ] **Backend port (8848) never exposed to public.** When using reverse proxy, backend must stay on `127.0.0.1` — otherwise people bypass Caddy and directly connect to 8848, auth becomes meaningless.
      ```bash
      ss -tlnp | grep 8848      # Should only see 127.0.0.1:8848
      ```
- [ ] **Strong random password.** This is the only gate, don't use `gpu123`.
      ```bash
      openssl rand -base64 24
      ```
- [ ] **Don't use pure HTTP on public internet.** Path 1 only for trusted internal network, see section 5 warning.
- [ ] **Add fail2ban to block brute-force.** Basic Auth has no rate limiting, relies on 401s in Caddy log to ban:

      ```ini
      # /etc/fail2ban/filter.d/caddy-auth.conf
      [Definition]
      failregex = "remote_ip":"<HOST>".*"status":401
      datepattern = "ts":{EPOCH}
      ```
      ```ini
      # /etc/fail2ban/jail.d/caddy-auth.local
      [caddy-auth]
      enabled  = true
      filter   = caddy-auth
      port     = 8443
      logpath  = /var/log/caddy/gpumon.log
      maxretry = 8
      findtime = 600
      bantime  = 3600
      ```
      ```bash
      sudo systemctl restart fail2ban
      sudo fail2ban-client status caddy-auth
      ```
      `port` must match your actual external port (path 2 is `http,https`, path 3 is `8443`).
- [ ] **Dedicated SSH key, don't reuse personal key.** Use regular account on target nodes, no sudo. For stricter control, add restrictions in `authorized_keys` on target nodes for this key, disable port forwarding / agent forwarding / pty:
      ```
      restrict ssh-ed25519 AAAA... gpumon@monitor-host
      ```
      Collection only needs command execution and stdin reading, `restrict` doesn't affect it. After changing must regression-test with section 2 verification command before going live.
- [ ] **Real infrastructure info not in repo.** `config/settings.toml` and `config/inventory.yaml` already in `.gitignore` because they contain real host keys, SSH aliases, and topology. `.gitignore` also excludes `*.env`, `deploy/DEPLOYMENT-local.md`, and all private keys. Before committing scan once:
      ```bash
      git status --short           # Should not show inventory.yaml / settings.toml / *.env
      ```
- [ ] **Password hash, DNS token, private keys only on deployment host locally**, `chmod 600`, never in repo.
- [ ] **Want to hide usernames** (public display, privacy compliance): `[privacy] mask_users = true` in `settings.toml`, web shows as `a***e`.

> **About login**: Current version has no built-in login page, access control relies on reverse proxy's Basic Auth (path 2/3) or network-layer isolation (path 1). Built-in login page coming in future version, then path 1 can also have application-level auth; but **even with login page, public exposure still must use HTTPS**.

---

## 10. Troubleshooting

| Symptom | Possible Cause | How to Check / Fix |
| --- | --- | --- |
| Some host `online: false` | SSH unreachable, alias typo, key not distributed | See `last_error`; manually run as service account `sudo -u <USER> ssh -o BatchMode=yes <alias> nvidia-smi -L`. **Must use service account**, you can connect doesn't mean it can (different keys and `~/.ssh/config`) |
| Some host `online: false`, `last_error` is timeout | Bastion slow, network jitter, node high load | Increase `ssh_connect_timeout_s` / `ssh_total_timeout_s` in `settings.toml`; `ssh -v <alias>` see where it hangs |
| All hosts offline | Collector not running, or `GPUMON_ROOT` wrong | `systemctl status gpumon-collector`; `journalctl -u gpumon-collector -n 50` |
| `gpus_seen` less than `gpus_expected` | GPU dropped / off bus, or `gpu_count` wrong | Login run `nvidia-smi -L \| wc -l`. Really missing is hardware issue (check `dmesg \| grep -i xid`); wrong number just fix `gpu_count` in inventory |
| `gpus_seen` is `0` or `null` | Account can't run `nvidia-smi`, or driver not up | `ssh <alias> 'nvidia-smi'` see error. AMD machine confirm `rocm-smi`/`amd-smi` available, if needed explicitly write `vendor: amd` in inventory |
| `gpus_seen` is `null` and no error | This host never successfully collected (in inventory but no DB record yet) | First `gpumon collect --once --host <key>` single-host debug |
| Web opens but no data / all `--` | Collector not running, or database path inconsistent | `curl 127.0.0.1:8848/api/health` check `last_sample_age_s`; confirm both services' `GPUMON_ROOT` point to same directory (inconsistent writes separate DBs) |
| Web has data but long time window blank | Aggregation tables not enough data yet, or retention days too short | `uv run gpumon rollup-once`; check `[retention]`: `raw_days` must be ≥ longest time window + margin, or "user ranking" undercounts |
| Ranking splits same person into two rows | Long username truncated by `ps` (`somebody` → `somebo+`) | Already fixed: probe script uses `ps -o user:32=` fixed width. Note `-w`/`-ww` only widens whole line, no effect on `user` column, can't substitute. Pre-fix history rows need separate backfill |
| Browser warns certificate untrusted | Using `tls internal` (self-signed) | Expected behavior, click "continue", traffic still encrypted. Want green lock use path 2/3 |
| Certificate won't sign (HTTP-01) | Inbound 80 unreachable, or DNS not propagated | `journalctl -u caddy \| grep -i acme`; `dig +short <YOUR_DOMAIN>` verify; inbound blocked switch to DNS-01 (path 3) |
| Certificate won't sign (DNS-01) | Token wrong, plugin not compiled in, DNS cache | `caddy list-modules \| grep dns.providers` (no output = plugin not included); add `resolvers 1.1.1.1 8.8.8.8` in `tls` block |
| `curl` gets RST at TLS handshake stage | Domain blocked by SNI | Add IP direct-connect entry + `default_sni`, see 7.5 |
| Password never matches | Hash's `$` got shell-expanded | `/etc/gpumon/caddy.env` use single quotes: `GPUMON_BASIC_HASH='$2a$14$...'`; after changing `systemctl restart caddy` (not reload) |
| Caddy won't start | Directive name version mismatch, port occupied | `caddy validate --config /etc/caddy/Caddyfile`; ≥2.8 use `basic_auth`, earlier use `basicauth`; `ss -tlnp \| grep -E ':(443\|8443)'` |
| Database `database is locked` | Two collectors running simultaneously | Only keep one of user-level or system-level: `systemctl --user disable --now gpumon-collector` |
| Changed inventory, web no response | Collector only reads config at startup | `systemctl restart gpumon-collector` (retired machines also restart `gpumon-web`) |

Fastest localization when collection fails — directly see raw probe output:

```bash
cd <ROOT> && ./scripts/probe_one.sh <ssh-alias>
```

It runs remote script verbatim and prints segmented output (`##META` / `##GPU` / `##APPS` ...). Which section empty, which section errors, instantly localize SSH layer, driver layer, or parsing layer issue.

---

## 11. Uninstall / Rollback

```bash
sudo systemctl disable --now gpumon-collector gpumon-web caddy
sudo rm -f /etc/systemd/system/gpumon-*.service
sudo systemctl daemon-reload

# Complete cleanup (as needed)
sudo rm -rf /etc/gpumon /etc/caddy/Caddyfile
sudo userdel -r <USER>
# Delete deployment public key from ~/.ssh/authorized_keys on each target node
# Close security group / firewall allowed ports
```

Database at `<ROOT>/data/gpumon.db`, backup before deleting directory if want to keep history.
