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
2. Back up your Postgres volume, your `VAULT_KEY` and your
   `CREDENTIAL_KEYCHAIN_KEY`.
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

Admin → Update fills these commands in with your **actual** app names when the
middleware detects it is running on Fly (it reads `FLY_APP_NAME`), so they are
copy-pasteable rather than templates.

> **`--image` lasts one deploy.** It overrides the `[build] image` line for that
> invocation only. Whoever next runs a plain `fly deploy` — a config change, a
> secret rotation, anyone following the README — puts the app back on whatever
> the TOML says. **Update the `image` line in `fly/middleware.fly.toml` and
> `fly/web-ui.fly.toml` too**, or keep pinning `--image` on every future deploy.
>
> This is the Fly counterpart to the compose stack's `.env` pin, with one
> difference worth knowing: on compose the updater writes that pin for you, and
> on Fly nothing can — `fly deploy` reads the operator's local TOML and no
> server-side setting overrides it.

Fly keeps the previous release: `fly releases --app <app>` then
`fly deploy --image <previous ref>` (or `fly releases rollback`) puts it back.
Neither path rolls back on its own, so watch the deploy — and the same
forward-only-migration caveat applies, so snapshot the Postgres volume first
(`fly volumes snapshots create <volume-id>`).

Do **not** redeploy the `omadia-postgres-<suffix>` app as part of a version
bump: it holds the data volume, exactly as with the compose stack.

## Upgrading past 0.167.5 — password sign-in is rate-limited

**Nothing to do for most installs.** The defaults are safe on every shipped
topology. What changes for operators:

- **Refusals instead of endless tries.** After five wrong passwords for one
  account from one client, further attempts wait (1 s, doubling, at most
  2 minutes) and answer 429 `auth.rate_limited`. A busy server answers 503
  `auth.busy`. Both carry `Retry-After`; scripted sign-ins
  (`curl … /api/v1/auth/login/local`) should honour it.
- **Unlocking an account.** A successful sign-in, an admin's password reset or
  re-enabling the user clears the wait. When no admin session is available,
  restart the middleware: the limiter lives in memory and a restart clears it.
- **A new cookie.** A successful sign-in (and the first-user wizard) sets
  `omadia_login_device`, which makes that browser one of the account's known
  browsers: they share a sign-in budget of their own and a reserved share of
  the sign-in capacity. Browsers that are signed in when the new version
  starts get it from the session check the admin UI runs every minute. It
  authenticates nothing and survives logout. It is tied to the account's
  password: after a password reset, a disable or a delete it no longer
  counts, and a browser gets a new one at its next sign-in or session check.
  Rotating the session signing key (the vault entry
  `core:auth/session_signing_key`) ends every such cookie and every session
  at once.
- **Passwords over 1024 characters can no longer sign in.** Setting one
  through the admin UI still works, so reset such a password to a shorter one.

**Fly.io.** Every client reaches the middleware from Fly's proxy or from
web-ui, so by default they all share one address. The limiter then relies on
the device cookie alone to keep operators apart. Key clients by the address
Fly's edge sets instead: `AUTH_LOGIN_CLIENT_ADDRESS=header:Fly-Client-IP`.
Not `xff:1`: Fly puts the app's own IP address right-most in
`X-Forwarded-For`, which would give every client the same key.
`fly/middleware.fly.toml` now sets it, so a `fly deploy --config
fly/middleware.fly.toml` picks it up. The one-click updater only swaps the
image and keeps the old settings; there, set the variable once with
`fly secrets set AUTH_LOGIN_CLIENT_ADDRESS=header:Fly-Client-IP --app
<middleware-app>`.

**docker-compose.** Keep the default `socket` unless every request reaches
web-ui through a reverse proxy that appends the client's address to
`X-Forwarded-For` (Caddy and Traefik do by default, nginx with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Then
`xff:1` keys clients by their own address. To check it, send six wrong
sign-ins through the proxy with a made-up `X-Forwarded-For` value: the
`[auth] login refused` log line must name your real address. On its own, the
web-ui proxy forwards the browser's header unchanged, so it is not a trusted
hop.

`AUTH_LOGIN_IPV6_PREFIX` (default 64) sets how much of an IPv6 address counts
as one client, and `AUTH_LOGIN_MAX_INFLIGHT` (default 4) bounds concurrent
argon2 runs; see `middleware/.env.example`.

## Upgrading past 0.167.5 — the first-user wizard asks for a setup token

**Nothing to do on an instance that already has an admin.** The change only
affects the first-user wizard (`/setup`), which such an instance has closed for
good.

**An instance whose wizard is still open** (fresh install, no user created
yet) now asks for a **setup token** before it creates the first admin. With
`ADMIN_SETUP_TOKEN` unset, the middleware generates one at start and prints it
once per start to its log. The value stays the same across restarts and
replicas until the first admin exists.

```bash
docker compose logs middleware | grep "setup token"      # compose
fly logs -a <middleware-app> | grep "setup token"         # Fly.io
```

Paste it into the wizard's **Setup token** field. To choose the value yourself,
set `ADMIN_SETUP_TOKEN` (at least 16 characters) in `middleware/.env` or as a
platform secret before the start. An empty `ADMIN_SETUP_TOKEN=` counts as unset.
The desktop app needs no token.

Two behaviour changes worth knowing:

- **Scripted setup** (`curl … /api/v1/auth/setup`) must send the token as the
  `setup_token` JSON field. Without it the answer is 403
  `auth.setup_token_invalid`. There is no header variant.
- **Emptying the `users` table does not reopen the wizard on the running
  process any more.** A boot that found users answers 410
  `auth.setup_disabled` until the middleware restarts. It used to create an
  admin anyway. Restart, then open the wizard.

Parallel wizard submissions now create exactly one admin. A late one gets 410
`auth.setup_locked`, and one that collides with a slow database gets 409
`auth.setup_in_progress`, which is safe to retry.

## Upgrading to 0.115 or later — `CREDENTIAL_KEYCHAIN_KEY` is required

> **Do this before pulling the image, or the update rolls back.**

Since v0.115 the middleware resolves a second master key at boot,
`CREDENTIAL_KEYCHAIN_KEY`, for the credential keychain (#578 / #778). It
follows exactly the `VAULT_KEY` rules: base64 of 32 random bytes, a dev-file
fallback under `NODE_ENV=development`, and a **hard boot failure** under
`NODE_ENV=production` when unset — which is what the shipped image runs.

What that means for an instance installed before v0.115:

- The old version never needed the key, so nothing ever asked you for it.
- The new version throws `CREDENTIAL_KEYCHAIN_KEY is required when
  NODE_ENV=production` before it starts listening.
- A rolling update (compose or Fly executor) therefore ends in
  `health gate failed: never_reachable (observed version: none)` and is rolled
  back. The instance keeps running the old version; nothing is lost.

### Steps

1. Generate a key — a **different** value than `VAULT_KEY`, it protects a
   separate trust domain:

   ```bash
   openssl rand -base64 32
   ```

2. Set it where the middleware reads its secrets:
   - compose: `CREDENTIAL_KEYCHAIN_KEY=…` in the project-root `.env`
   - Fly: `fly secrets set CREDENTIAL_KEYCHAIN_KEY=… --app <middleware-app>`
   - Render: add the env var on the middleware service (new blueprints
     generate it automatically)
3. Keep it as safe as `VAULT_KEY`: losing it makes keychain entries
   unrecoverable.
4. Run the update again.

Fresh installs via `render.yaml` or `fly/deploy.sh` generate the key
themselves; only pre-v0.115 instances have to add it by hand.

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
