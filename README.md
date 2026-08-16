# OfficeAgent

Self-hosted Telegram-driven agent office, built on Claude Code. This is a
skeleton/transplant checkpoint — see **Status** below before relying on
anything here.

## What this is

OfficeAgent packages the mechanics behind a real, in-production Telegram
"office" agent — identity + memory + tool-calling + skills, permission
gating with owner confirm/deny, per-topic parallel sessions, an
inter-agent swarm/task board, and an optional second model provider — as
something you run on your own server, under your own Telegram bot token,
talking to your own Claude account. Nobody else's data, nobody else's
server.

Two services do the work, both running directly on the host under
systemd (not containerized — see **Architecture** below):

- **`bot/`** — Telegram poller, per-topic session router, tmux-hosted
  `claude` CLI sessions, and a loopback HTTP surface for permission
  requests / model switching / inter-agent notifications. (Ported from an
  internal `channel-plugin`.)
- **`gbrain/`** — memory (write), recall (hybrid search), swarm
  (inter-agent delivery) and task (board) as MCP tools, served from one
  Python process on one port.

Both talk to a single Postgres+pgvector database, which is the ONE piece
that runs in Docker.

## Architecture

Postgres+pgvector runs in Docker (`docker-compose.yml`, service `db`) —
the one component that genuinely benefits from a pinned, reproducible
image. `bot/` and `gbrain/` run as ordinary host processes under systemd
(`systemd/officeagent-{db,gbrain,bot}.service`), each under its own
non-privileged system user (`officeagent`, `nologin`, no sudo).

This is deliberately NOT a full docker-compose stack with a container per
service. An earlier draft of this repo did package `bot`/`gbrain` as
containers too — that added real overhead (extra memory per container,
image build/push pipeline, registry hosting) for no benefit on the kind
of small VPS this product targets, and it diverged from how the
internal system this was ported from actually runs (systemd units
talking straight to a host process), which is also how the comparable
`edgelab-install`-style installers in this space work. Postgres is the
exception because "run a pinned upstream image" is exactly what Docker is
good at, and the alternative (compiling pgvector against the host's
Postgres) is real yak-shaving for zero benefit.

## Status (read this first)

This repository is a **mechanical transplant checkpoint**, not a finished
product. What exists:

- `bot/src/**` type-checks clean (`bun x tsc --noEmit`, zero errors).
  `bot/tests/**` does NOT yet — test fixtures still reference field/value
  names from before the `/model` generalization (§0.4) and the
  terminal-mirror removal (§0.1 category 1); that adaptation pass hasn't
  happened yet.
- `gbrain/services/server.py` (the merged 4-MCP process) is written but
  **UNTESTED** — this environment has no Postgres/pgvector/FastMCP
  runtime to actually boot it against. Read its module docstring before
  trusting it in production.
- `install.sh` and the three `systemd/*.service` units are written but
  have **never been run end-to-end** against a real host — there is no
  disposable VM available in this environment to validate them against.
  Read `install.sh` top to bottom before running it as root.
- No `officeagent` CLI, no INSTALL.md/SECURITY.md yet.
- A real functional gap, found while writing `docker-compose.yml`, is
  flagged inline there: `bot`'s webhook (`bot/src/webhook/server.ts`)
  hard-rejects any non-loopback TCP peer on every route, which mattered
  when `bot`/`gbrain` were going to be separate containers reaching each
  other over a docker network — with both now running on the SAME host
  reaching each other via `127.0.0.1`, this particular gap is now largely
  moot, but the comment is left in place as a record of the finding in
  case a container-based deployment is revisited later.

None of the above is hidden — this is the honest state after one
mechanical-transplant pass, including a mid-pass architecture correction
(container-per-service → host-process-under-systemd + Postgres-only
Docker). Full security hardening, the installer's first real run, and
test-suite adaptation are separate follow-up phases.

## Repository layout

```
bot/                  Telegram bot + session router (TypeScript, bun)
gbrain/                memory/recall/swarm/task MCP services (Python)
templates/              workspace/vault templates rendered for a new install
skills/                  officeagent-doctor, mcp-builder (generic starter skills)
systemd/                 officeagent-{db,gbrain,bot}.service
docker-compose.yml       Postgres+pgvector ONLY
install.sh               apt packages, venv/bun install, systemd enable
env.example              reference for every config value (see its header)
```

## Running it (once you've read Status above)

```bash
sudo bash install.sh
```

`install.sh` asks for your Telegram bot token, your Telegram user id,
Claude auth, and (optionally) an alternative model provider, then
installs everything under `/opt/officeagent`, starts Postgres via
`docker compose up -d db`, applies migrations, and enables the two
systemd services. See `env.example` for what every value means if you'd
rather set it up by hand.

## License

Not yet chosen — see `LICENSE`.
