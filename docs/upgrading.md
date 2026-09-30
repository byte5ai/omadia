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
Docker Engine access, which is host-root-equivalent. The overlay confines that
access to two containers on a network of their own:

- `docker-socket-proxy` is the only container with `/var/run/docker.sock`
  mounted (read-only). It has no authentication, and the Engine calls an
  update needs are host-root-equivalent on their own, so its flag list is not
  what protects you. Reachability is: the proxy sits on `omadia-control`
  alone, an `internal` network without a host-side address.
- `updater` is the only service on both `omadia-control` (to reach the proxy)
  and the application network `omadia` (so the middleware can call it, and it
  can check the middleware's `/health`). It has no published port and demands
  the shared `UPDATER_TOKEN` on every call.

Nothing on `omadia` (middleware, web-ui, postgres, any overlay sidecar) can
resolve or reach the proxy. **Never attach another service to
`omadia-control`**: whatever joins it can drive the Docker Engine, which means
it owns the host. Treat the updater the same way. It is root-equivalent by
design, and the middleware holds its token, so anything that takes over the
middleware can start an update to any release tag, older ones included.
Details: [`security-architecture.md`](security-architecture.md) §10e and
[`middleware/sidecars/updater/README.md`](../middleware/sidecars/updater/README.md).

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

#### Already running the overlay

Pull the new compose files, then re-run the overlay with **both** files, plus
every other overlay you normally use:

```bash
docker compose -f docker-compose.yaml -f docker-compose.update.yaml up -d
```

Compose creates `omadia-control` and recreates only `docker-socket-proxy` and
`updater`. The middleware, web-ui and your data are not touched. An update
that is running at that moment is aborted, because the updater keeps its job
state in memory. A plain `docker compose up -d` without the overlay leaves the
old proxy and updater running on `omadia` as orphans (compose only prints a
warning), so the old exposure stays. Add `--remove-orphans` only when your
`-f` list contains every overlay you run; otherwise it also removes the
containers of the overlays you left out. Then run the check below.

#### Checking the control network

Run this in the project directory after enabling the overlay, and again after
any change to Docker or the host firewall. If you start the stack with more
`-f` files or a `-p` project name, add them to the `compose()` line. The check
ends with one verdict and a matching exit code: `PASS` (0), `FAIL` (1) or
`INCONCLUSIVE` (2).

```sh
sh -eu <<'CHECK'
# Use the same -f files (and -p, if you use one) as for `up`.
compose() { docker compose -f docker-compose.yaml -f docker-compose.update.yaml "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
unsure() { echo "INCONCLUSIVE: $*" >&2; exit 2; }
one() { case $2 in '' | *[!0-9a-f]*) unsure "expected one running $1 container" ;; esac; }

# 1. One running container per service, in this compose project.
PROXY=$(compose ps -q docker-socket-proxy) || unsure "docker compose failed; run this in the project directory"
UPDATER=$(compose ps -q updater) || unsure "docker compose failed"
MIDDLEWARE=$(compose ps -q middleware) || unsure "docker compose failed"
one docker-socket-proxy "$PROXY"; one updater "$UPDATER"; one middleware "$MIDDLEWARE"

# 2. The proxy is on the control network alone; that network is internal and
#    has two members (the updater has to prove below that it is the other one).
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PROXY") ||
  unsure "cannot inspect docker-socket-proxy"
NET=$(docker network ls --format '{{.Name}}' --filter label=com.docker.compose.network=omadia-control \
  --filter "label=com.docker.compose.project=$PROJECT") || unsure "cannot list networks"
[ -n "$NET" ] || fail "project $PROJECT has no omadia-control network"
PROXY_NETS=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$PROXY") ||
  unsure "cannot inspect docker-socket-proxy"
[ "$PROXY_NETS" = "$NET" ] || fail "docker-socket-proxy is not on $NET alone: $PROXY_NETS"
NET_INFO=$(docker network inspect -f '{{.Internal}} {{len .Containers}}' "$NET") || unsure "cannot inspect $NET"
[ "$NET_INFO" = "true 2" ] || fail "$NET must be internal with two members (internal, members: $NET_INFO)"

# 3. The proxy's address on that network: exactly one dotted quad.
PROXY_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$PROXY") ||
  unsure "cannot read the proxy's address on $NET"
case $PROXY_IP in
  *[!0-9.]* | *.*.*.*.* | .* | *. | *..*) unsure "unexpected proxy address '$PROXY_IP'" ;;
  *.*.*.*) ;;
  *) unsure "unexpected proxy address '$PROXY_IP'" ;;
esac

# 4. Probe by name and by address. The probe exits 3 when the proxy answered
#    where it must not, 4 when an outcome proves nothing either way.
PROBE='
const expectReach = process.env.EXPECT === "reach";
const blockedBy = {
  name: ["ENOTFOUND"],
  address: ["TimeoutError", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED"],
};
const targets = [["name", "docker-socket-proxy"], ["address", process.env.PROXY_IP]];
Promise.all(targets.map(([kind, host]) =>
  fetch(`http://${host}:2375/_ping`, { signal: AbortSignal.timeout(4000) }).then(
    (res) => ({ kind, host, seen: res.status }),
    (err) => ({ kind, host, seen: String(err.cause?.code ?? err.name) }),
  ),
)).then((results) => {
  let code = 0;
  for (const { kind, host, seen } of results) {
    const verdict = expectReach
      ? (seen === 200 ? "reached" : "INCONCLUSIVE")
      : typeof seen === "number" ? "REACHABLE"
      : blockedBy[kind].includes(seen) ? "blocked" : "INCONCLUSIVE";
    console.log(`  by ${kind} (${host}): ${verdict} [${seen}]`);
    if (verdict === "REACHABLE") code = 3;
    else if (verdict === "INCONCLUSIVE" && code === 0) code = 4;
  }
  process.exitCode = code;
});'
probe() {  # probe <service> <container> <reach|blocked>
  echo "$1 -> docker-socket-proxy (expected: $3)"
  rc=0
  docker exec -e EXPECT="$3" -e PROXY_IP="$PROXY_IP" "$2" node -e "$PROBE" || rc=$?
  case $rc in
    0) ;;
    3) fail "$1 reaches the proxy: this host does not isolate $NET" ;;
    *) unsure "no clear answer from $1 (exit $rc); this is not a pass" ;;
  esac
}
# The updater has to get through first; otherwise "blocked" below proves nothing.
probe updater "$UPDATER" reach
probe middleware "$MIDDLEWARE" blocked
WEB_UI=$(compose ps -q web-ui) || WEB_UI=
if [ -n "$WEB_UI" ]; then one web-ui "$WEB_UI"; probe web-ui "$WEB_UI" blocked; fi
echo "PASS: only the updater reaches docker-socket-proxy ($PROXY_IP on $NET)"
CHECK
```

On an isolated host the output looks like this (addresses differ):

```text
updater -> docker-socket-proxy (expected: reach)
  by name (docker-socket-proxy): reached [200]
  by address (172.19.0.2): reached [200]
middleware -> docker-socket-proxy (expected: blocked)
  by name (docker-socket-proxy): blocked [ENOTFOUND]
  by address (172.19.0.2): blocked [TimeoutError]
web-ui -> docker-socket-proxy (expected: blocked)
  by name (docker-socket-proxy): blocked [ENOTFOUND]
  by address (172.19.0.2): blocked [TimeoutError]
PASS: only the updater reaches docker-socket-proxy (172.19.0.2 on <project>_omadia-control)
```

Depending on the runtime, the address probe ends in `TimeoutError`,
`EHOSTUNREACH`, `ENETUNREACH` or `ECONNREFUSED`. Those four, and `ENOTFOUND`
for the name, are the only answers the check counts as blocked, and only after
the updater has reached the proxy at the same name and address.

- **FAIL**: the proxy answered the middleware or the web-ui, or the layout is
  wrong (the proxy is on a second network, the control network is missing or
  not `internal`, or it does not have exactly two members). Treat the host as
  not isolating the control network. Stop the two services
  (`docker compose -f docker-compose.yaml -f docker-compose.update.yaml stop docker-socket-proxy updater`)
  and find out why before you start them again; the runtimes checked so far
  are listed in [`security-architecture.md`](security-architecture.md) §10e.
- **INCONCLUSIVE** is not a pass: the check could not tell. Typical causes are
  running it outside the project directory or without your `-p`, a service
  that is not running, an updater that cannot reach the proxy, or a probe
  error that says nothing about isolation, such as a failing DNS server. Fix
  the cause and run the check again.

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
