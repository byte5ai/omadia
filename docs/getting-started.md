# Getting started

Run omadia on your own machine, take the first run from prompt to receipt, and
switch on the optional features. To run it anywhere else, read
[Deployment](deployment.md) first: production needs two secrets.

## Prerequisites

The quickstart runs entirely in containers, so the host stays light:

- **Docker 24+** with the Docker Compose v2 plugin (the `docker compose`
  subcommand, not the legacy `docker-compose` binary)
- **Git**, to clone the repository

That is the whole list for running omadia. A local Node toolchain is only
needed when you build the services from source or develop plugins:

- **Node 22.x** for the middleware and admin UI outside Docker. The pinned
  version lives in `.nvmrc`, so `nvm use` picks it up. The middleware blocks
  installation on a mismatched major version, because native modules are
  built against a specific ABI.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full from-source setup.

## Quickstart

```bash
git clone https://github.com/byte5ai/omadia.git && cd omadia

# 1. Bring up the minimal core: postgres + middleware + admin UI.
#    Images are pulled prebuilt from GHCR, so first boot is a download,
#    not a source build. No config needed to start.
docker compose up -d

# 2. Copy the one-time setup token the middleware printed at start.
#    The first-admin wizard only accepts it, so nobody else can claim
#    your fresh install.
docker compose logs middleware | grep "setup token"

# 3. Open the admin UI and complete the first-admin wizard with that token.
open http://localhost:3333
```

`docker compose up -d` pulls exactly three services and nothing else. Open the UI,
create the first admin with the setup token, connect your LLM under
**Admin → LLM access**, and run your first agent team. Diagrams, embeddings, and
object storage are opt-in (see [Optional features](#optional-features)). Prefer
to choose the token yourself? Set `ADMIN_SETUP_TOKEN` (16+ characters) in
`middleware/.env` before the first start.

Pin a specific release instead of the latest with the `OMADIA_VERSION` shell
variable (or a project-root `.env` file, not `middleware/.env`), or build the
images from source instead of pulling:

```bash
OMADIA_VERSION=v0.3.0 docker compose up -d                              # pin a release
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build  # build locally
```

> **Pull fails with `manifest unknown`?** The GHCR images publish on each
> release, so a brand-new checkout can briefly predate the first published
> image. Build from source with the `--build` line above until a release lands.

## No Docker? Let your AI assistant install it

Prefer not to touch a terminal? If you have the **Claude** desktop app (or
another AI assistant that can run commands on your machine, such as Codex), paste
the prompt below into a chat. The assistant fetches a public skill file and
installs the native omadia desktop app (no Docker, no build tools) from the
newest GitHub Release that has a build for your OS, then opens the onboarding
wizard for you. On a Mac the app needs macOS 13 (Ventura) or later; the skill
checks this before it downloads anything.

```text
Install omadia on my machine by following this skill file, step by step:
https://raw.githubusercontent.com/byte5ai/omadia/main/docs/onboarding/SKILL.md
```

On a **Claude Pro/Max** subscription you can pick the CLI-subscription provider in
the wizard instead of a metered API key, provided the `claude` CLI is installed
and signed in on the same machine (omadia detects it there). Otherwise the API-key
option always works. See [`onboarding/SKILL.md`](onboarding/SKILL.md) for exactly
what it runs.

## First run: from prompt to audit receipt

omadia clicks once you watch a team of agents do real work and hand you a receipt
for it:

1. Run **`docker compose up -d`**. The minimal core (postgres, middleware, admin UI) comes up together.
2. **Open `http://localhost:3333`** and finish the first-admin `/setup` wizard
   with the setup token from `docker compose logs middleware`.
3. **Start a demo agent team** from a single prompt in the web chat.
4. **Watch it work.** The orchestrator streams turns and dispatches tools across
   the agents in the team.
5. **Open the run's trace.** The per-run call-stack viewer shows every step, tool
   call and decision of the run. The trace is telemetry. The audit record is the
   hash-chained receipt under `/operator/receipts` (Postgres backend), written
   best-effort for each turn in which the Privacy Shield acted. A turn whose
   receipt write failed has none, and the server log records the failure.

What the Privacy Shield, the answer verifier and the receipts cover, and where
they stop, is listed in [Trust & privacy](trust-and-privacy.md).

## Optional features

The minimal core is postgres + middleware + admin UI. Diagrams, embeddings, and
object storage are off by default. Each is an overlay file you add with `-f`,
which starts the sidecar and switches on the matching plugin.

```bash
# Object storage (MinIO): chat attachment ingestion
docker compose -f docker-compose.yaml -f docker-compose.storage.yaml up -d

# Diagram rendering (Kroki). Needs object storage, so add both overlays:
docker compose -f docker-compose.yaml \
  -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml up -d

# In-tenant embeddings (Ollama). First boot pulls nomic-embed-text (~270 MB),
# so it needs network access the first time it starts.
docker compose -f docker-compose.yaml -f docker-compose.embeddings.yaml up -d

# Everything at once
docker compose -f docker-compose.yaml \
  -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml \
  -f docker-compose.embeddings.yaml up -d
```

> **Diagram rendering** also needs a signing secret. Generate one and add it to
> `middleware/.env` as `DIAGRAM_URL_SECRET` before starting the diagrams overlay:
> `openssl rand -hex 32`. The plugin stays inactive until it is set.

## Troubleshooting

**Port already in use.** The core binds `3333` for the admin UI plus the
Postgres port. If another process holds one of them, the affected container
exits on start. Free the port, or remap it in your own compose override, then
re-run `docker compose up -d`.

**Optional overlay not found.** Optional features are overlay files added with
repeated `-f` flags, not Compose profiles. Pass the full filename, for example
`-f docker-compose.yaml -f docker-compose.storage.yaml`. A bare `--profile
storage` matches nothing here.

**Node version mismatch from source.** The middleware pins its Node major
version in `.nvmrc` and stops `npm install` on a different one, because
`better-sqlite3` and other native modules are compiled against a specific ABI.
Run `nvm use` in the repository root before installing.

**Missing secrets or a rolled-back update on a deployed instance?** See
[Deployment troubleshooting](deployment.md#troubleshooting).
