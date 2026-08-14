# Upgrade and migration guide

How to move an omadia deployment from one version to the next.
[`CHANGELOG.md`](CHANGELOG.md) records *what* changed; this guide covers *how
to migrate*: renamed environment variables, schema changes, removed config
keys, and shifts in the plugin API.

> **Pre-1.0 caveat.** omadia is in public preview. Database schemas and
> internal surfaces may break between minor versions until `1.0.0`. SQL
> migrations themselves are applied automatically at boot (each subsystem runs
> its own forward-only series), so the hand-rolled part of an upgrade is the
> rest: renamed environment variables, removed config keys, and plugin-API
> shifts. They are also forward-only — downgrading an image does not undo a
> migration. Read the section for your target version before pulling a new
> image, and back up the volume first.

## General upgrade steps

1. Read the section for your target version below, plus the
   [`CHANGELOG.md`](CHANGELOG.md) entries since your current one.
2. Back up your Postgres volume and your `VAULT_KEY`.
3. Pull the new image. Pin a release with `OMADIA_VERSION`, see the
   [README quickstart](../README.md#-quickstart).
4. Restart with `docker compose up -d`.
5. Verify the admin UI comes up and an existing agent run still works.

## Updating from the Operator UI

**Admin → Update** reports the version this instance is running and whether a
newer release exists. What it can *do* from there depends on which optional
pieces are deployed:

| Deployment | Admin → Update can |
|---|---|
| default stack | show the running version and flag a newer release (notify-only) |
| + Postgres (the default compose stack has it) | additionally keep an audit trail of update requests |
| + `docker-compose.update.yaml` | additionally apply a version bump |

### Enabling one-click updates

The executor is **opt-in**, because replacing running containers requires
Docker Engine access, which is host-root-equivalent. It is isolated in a
sidecar that reaches the Engine only through a `docker-socket-proxy` with a
narrow endpoint allowlist, has no published port, and requires a shared token —
see [`middleware/sidecars/updater/README.md`](../middleware/sidecars/updater/README.md).

```bash
# The updater rewrites OMADIA_VERSION in the project-root .env, so the file has
# to exist as a FILE before the bind mount is created.
touch .env
echo "UPDATER_TOKEN=$(openssl rand -hex 24)" >> .env
# On Linux, if your uid is not 1000, also set UPDATER_UID / UPDATER_GID.

docker compose -f docker-compose.yaml -f docker-compose.update.yaml up -d
```

Then open **Admin → Update**, retype the target version to confirm, and start
the update. The page polls through the restart — the middleware is briefly
unavailable while its container is replaced.

### What the update does

1. Pulls every new image **before** stopping anything.
2. Pins `OMADIA_VERSION=<target>` in the project-root `.env`, so your next
   manual `docker compose up -d` keeps the version you chose.
3. Recreates `middleware` and `web-ui` from their own container config — same
   labels, mounts, ports, restart policy, network aliases; only the image
   changes.
4. Waits for `/health` to report the **new** version.
5. On failure, restores the previous `.env` pin and the previous images.

### Limits worth knowing before you click

- **Compose only.** Fly.io and Kubernetes deployments update through their own
  pipelines — see [Updating a Fly.io deployment](#updating-a-flyio-deployment)
  below. The desktop app updates itself via `electron-updater`.
- **Postgres is never touched.** `pgvector/pgvector:pg17` owns your data
  volume and is on a hard-coded protected list.
- **Rollback restores images, not the database.** Kernel migrations under
  `middleware/migrations/` are forward-only and are applied automatically at
  boot, so a rolled-back image can meet an already-migrated schema. Snapshot
  the `postgres-data` volume before a major bump — step 2 of the general
  upgrade steps above is not optional just because the button exists.
- **Release tags only.** `latest`, `edge` and `sha-…` are refused: a moving tag
  makes both the rollback target and the health gate undecidable.
- **Single-instance stacks only.** A scaled service is refused rather than
  half-updated. "Rolling" here means recreate-with-seconds-of-downtime.

## Updating a Fly.io deployment

Fly runs each app as a Firecracker microVM, so the *Docker* executor cannot run
there. Since #696 there is a **Fly executor** that drives the Machines API
instead, deployed as its own tiny app:

```bash
OMADIA_WITH_UPDATER=1 ./fly/deploy.sh
```

That provisions `omadia-updater-<suffix>`, mints an **app-scoped deploy token**
per managed app (`fly tokens create deploy` — limited to one app, expirable,
revocable), and points the middleware at it. The updater app has no public
address at all: it is reachable only over the org's private 6PN network, and
additionally behind the shared `UPDATER_TOKEN`.

To add it to a stack that is already deployed, create the app and set the same
secrets by hand — the block in `fly/deploy.sh` is the reference list.

What it does per update: verify the tag exists in the registry **before**
touching anything, then, per app, take a lease, read the machine, change only
`config.image`, write it back with `current_version`, and wait for `started` —
finally gating on the middleware's `/health` reporting the new version, and
rolling both apps back if it does not.

> **It cannot make the version stick.** The compose updater writes
> `OMADIA_VERSION` into the project `.env`; on Fly there is no equivalent,
> because `fly deploy` reads the operator's *local* `fly.toml` and nothing
> server-side overrides it. Admin → Update says so next to the button. After a
> one-click update, change the `image` line in `fly/middleware.fly.toml` and
> `fly/web-ui.fly.toml` yourself, or the next plain `fly deploy` reverts the
> apps.

Without the updater app, a Fly deployment stays in notify-only mode — which is
also what the rest of this section describes:

| Admin → Update on Fly | |
|---|---|
| Running version | ✅ — the published image carries its `OMADIA_VERSION` stamp |
| "A newer release exists" | ✅ — checked against GitHub Releases |
| Audit trail | ✅ — the middleware has Postgres |
| Apply the update | ❌ without the updater app — notify-only; the page shows the `fly deploy` command. ✅ with it |
| Keep the chosen version across a later `fly deploy` | ❌ always — see the note above |

The update itself is a redeploy pinned to the release tag. Take the app names
from `fly apps list` (the deploy script names them `omadia-middleware-<suffix>`
and `omadia-web-ui-<suffix>`):

```bash
VERSION=v0.75.0

# Middleware first — it owns the schema migrations that run at boot.
fly deploy --app omadia-middleware-<suffix> --config fly/middleware.fly.toml \
  --image ghcr.io/byte5ai/omadia-middleware:$VERSION

# Wait for it to report the new version before moving the UI.
curl -s https://omadia-middleware-<suffix>.fly.dev/health | jq .version

fly deploy --app omadia-web-ui-<suffix> --config fly/web-ui.fly.toml \
  --image ghcr.io/byte5ai/omadia-web-ui:$VERSION
```

`--image` overrides the `[build] image` line in the TOML for that deploy, so
the config files stay on `:latest` and each upgrade is explicit. Fly keeps the
previous release: `fly releases --app <app>` then
`fly deploy --image <previous ref>` (or `fly releases rollback`) puts it back —
the same forward-only-migration caveat applies, so snapshot the Postgres volume
first (`fly volumes snapshots create <volume-id>`).

Do **not** redeploy the `omadia-postgres-<suffix>` app as part of a version
bump: it holds the data volume, exactly as with the compose stack.

## Upgrading to 0.3

> Stub. Fill this in as part of the 0.3 release.

### Breaking changes

- _none recorded yet_

### Steps

1. Pull the new image.
2. Run the database migration if the schema changed (called out in the
   CHANGELOG).
3. Update any plugins built against an older `@omadia/plugin-api`.

## Keeping this guide current

Add a section per minor version as part of the release process. Even a short
stub beats a blank page: record renamed env vars, schema migrations, and
removed config keys while they are fresh.
