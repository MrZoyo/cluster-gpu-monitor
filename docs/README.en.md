# Documentation Index

[简体中文](README.md) | English | [Project home](../README.en.md)

The project README explains whether Cluster GPU Monitor fits your environment and gives the
shortest runnable path. This index routes each task to a focused guide instead of one oversized
manual.

## Where to start

| Goal | Start here | What it covers |
| --- | --- | --- |
| Run the project for the first time | [README quick start](../README.en.md#quick-start) | Dependencies, configuration, one collection round, and the Web UI |
| Add hosts or tune runtime settings | [Configuration reference](CONFIGURATION.en.md) | Inventory, settings, states, badges, retention, and concurrency |
| Understand the data model | [Architecture and trade-offs](ARCHITECTURE.en.md) | SSH collection, SQLite, rollups, liveness, GPU hours, and security boundaries |
| Generate fictional data or a static site | [Demo guide](DEMO.en.md) | Local demos, GitHub Pages export, and destructive-operation guards |
| Run a persistent service | [Deployment guide](DEPLOYMENT.en.md) | Release layout, systemd, Caddy, backups, migration, and troubleshooting |

## Suggested paths

### Try it locally

1. Follow the [README quick start](../README.en.md#quick-start) to create both configuration files.
2. Run `ssh <alias> true` to confirm non-interactive access from the central host.
3. Run `gpumon config-check` and `gpumon collect --once`.
4. Use the [configuration reference](CONFIGURATION.en.md) for field-level questions.

No GPU node is required for evaluation. The [demo guide](DEMO.en.md) creates entirely fictional
data.

### Prepare a production deployment

1. Read the security boundaries in [Architecture and trade-offs](ARCHITECTURE.en.md), especially
   that the Web application has no built-in authentication.
2. Complete sections 1–4 of the [deployment guide](DEPLOYMENT.en.md).
3. Choose direct HTTP, domain HTTPS, or DuckDNS from the three access paths.
4. Complete the security checklist and health checks before opening access.

## Documentation boundaries

- `README.md` is the landing page; it does not duplicate the full configuration or runbook.
- `CONFIGURATION.en.md` is the source of truth for configuration fields.
- `ARCHITECTURE.en.md` describes current behavior and deliberate trade-offs, not a roadmap.
- `DEPLOYMENT.en.md` keeps copyable production procedures.
- `DEMO.en.md` is for fictional data only; real databases should never enter static export.

If documentation and code disagree, treat the current code and example configuration as
authoritative, then open an issue or patch with reproduction steps.
