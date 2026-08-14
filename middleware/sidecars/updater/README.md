# omadia updater sidecar (#432)

Executes an operator-triggered version bump of the running compose stack.
Opt-in — the default stack does not include it, and omadia then runs in
**notify-only** mode: the admin page still reports the running version and
flags a newer release, it just cannot apply one.

```bash
docker compose -f docker-compose.yaml -f docker-compose.update.yaml up -d
```

Published as `ghcr.io/byte5ai/omadia-updater` by
`.github/workflows/publish-images.yml`, on the same tags as the middleware it
updates — so the overlay pulls it with the same `${OMADIA_VERSION}` as
everything else and no source checkout is needed. To run a locally built one,
build it under the same name first:

```bash
docker build -t ghcr.io/byte5ai/omadia-updater:latest middleware/sidecars/updater
```

## Why a sidecar at all

Replacing a running container requires the Docker Engine API, and access to it
is host-root-equivalent. Rather than give the middleware that reach, the
capability is isolated into this container:

| Boundary | Enforcement |
|---|---|
| No Docker socket in an application container | Only this sidecar talks to the Engine, and only through `docker-socket-proxy` |
| Not reachable from the internet or the browser | No `ports:` mapping — compose-network only |
| Not reachable by anything else on that network | Shared bearer token, constant-time compared; refuses to start without one |
| Cannot be aimed at an arbitrary image | Target must be a release tag (`vX.Y.Z`); floating tags are rejected |
| Cannot touch the database | `postgres` is on a hard-coded protected list, alongside the sidecar itself and the proxy |

## Wire contract

Mirrored by `middleware/src/update/updaterClient.ts`.

| Route | Auth | Response |
|---|---|---|
| `GET /healthz` | none | `200 {"ok":true}` — compose healthcheck |
| `GET /status` | bearer | `200` `UpdaterStatus` |
| `POST /update` | bearer | `202 {"accepted":true}`, `400 invalid_target_version`, `409 update_in_progress` |

`UpdaterStatus`:

```jsonc
{
  "state": "idle|updating|succeeded|failed|rolled_back",
  "targetVersion": "v0.75.0",
  "previousVersion": null,
  "startedAt": "2026-08-13T…",
  "finishedAt": null,
  "error": null,
  "steps": ["2026-08-13T… pulling ghcr.io/byte5ai/omadia-middleware:v0.75.0", "…"]
}
```

`POST /update` answers **before** the work starts, on purpose: the update
recreates the middleware container that is waiting on the response, so holding
the connection open would only guarantee it dies mid-flight. Callers poll
`/status` (the admin UI does this via `GET /api/v1/admin/update/status`).

## Update sequence

1. Resolve every target container — an unknown or scaled service aborts here.
2. **Pull every new image before stopping anything.** A typo'd tag or a GHCR
   outage is then discovered while the old stack is still fully up.
3. Pin `OMADIA_VERSION=<target>` in the project-root `.env`, so the operator's
   next manual `docker compose up -d` does not silently revert the stack.
4. Recreate each service from its own inspect output — same labels, mounts,
   ports, restart policy, network aliases; only `Image` changes. The stale
   `OMADIA_VERSION` env entry is dropped so the new image's baked stamp wins.
5. Gate on the middleware's `/health` **reporting the new version**, not merely
   answering.
6. On any failure: restore the previous `.env` pin and recreate every replaced
   container on its previous image, in reverse order.

## What rollback does not undo

Schema migrations. The kernel migrations under `middleware/migrations/` are
forward-only and applied automatically at boot by the harness-orchestrator
plugin, so a rolled-back image can meet an already-migrated database. Snapshot
the `postgres-data` volume before a major bump — see `docs/upgrading.md`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `UPDATER_TOKEN` | — | **Required**, ≥16 chars. Refuses to start without it. |
| `UPDATER_DOCKER_API` | `http://docker-socket-proxy:2375` | Engine API base URL |
| `UPDATER_SERVICES` | `middleware,web-ui` | Update order. Protected services are refused. |
| `UPDATER_COMPOSE_PROJECT` | auto-detected | From this container's own compose labels |
| `UPDATER_ENV_FILE` | `/workspace/.env` | Bind-mounted project-root `.env` |
| `UPDATER_HEALTH_URL` | `http://middleware:8080/health` | Health gate target |
| `UPDATER_HEALTH_TIMEOUT_MS` | `300000` | Rollback after this |
| `UPDATER_PORT` | `8090` | Compose-network only |

## Tests

```bash
node --test test/*.test.mjs
```

Runs in CI as part of the `middleware` job. No install step — there are no
dependencies.

## Scope

Compose stacks only — this sidecar needs a Docker Engine to talk to.

- **Fly.io**: no Docker daemon (Firecracker microVMs), so the sidecar cannot
  run there. The version surface and the release check still work; applying an
  update is `fly deploy --image …`, documented in `docs/upgrading.md`.
- **Kubernetes**: same shape — the update belongs to whatever reconciles the
  Deployment.
- **Desktop**: already auto-updates via `electron-updater`
  (`desktop/src/updater.ts`).

A Fly/Machines-API executor would slot in behind the same
`middleware/src/update/updaterClient.ts` contract if it is ever wanted; nothing
in the middleware assumes Docker.
