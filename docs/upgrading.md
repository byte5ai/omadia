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
4. Restart with `docker compose up -d`. If you run overlays, pass the same
   `-f` files you start the stack with; a plain `up` leaves their services
   running as they were.
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
Details: [`security-architecture.md`](security-architecture.md) §10f and
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

Compose creates `omadia-control` and recreates `docker-socket-proxy` and
`updater`. Your data is not touched, and neither are the middleware and web-ui
if compose started them on the release they run now. If Admin → Update
installed that release, compose restarts them once, on the same images,
because they still carry compose's configuration label from the previous
release. An update that is running at that moment is aborted, because the
updater keeps its job state in memory. A plain `docker compose up -d` without
the overlay leaves the old proxy and updater running on `omadia` as orphans
(compose only prints a warning), so the old exposure stays. Add
`--remove-orphans` only when your `-f` list contains every overlay you run;
otherwise it also removes the containers of the overlays you left out. Then
run the check below.

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
  are listed in [`security-architecture.md`](security-architecture.md) §10f.
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
  below. The desktop app updates itself via `electron-updater` and snapshots
  its embedded database together with its encrypted `secrets.enc` first (not
  `platform-data/`); see `desktop/README.md` § Secrets and recovery.
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

## Upgrading past v0.167.12 — desktop app: database passwords, no TCP port on macOS and Linux

On macOS and Linux the desktop app's embedded database no longer listens on a
TCP port, and on every platform it now requires passwords. Existing installs
migrate on their first start after the update: the local PostgreSQL cluster
moves from password-less `trust` rules to SCRAM passwords, and the kernel to a
role without superuser rights (`desktop/README.md` § Database authentication).
Nothing to do beforehand. The log of that start says so:
`[db] migrating a trust-authenticated cluster to SCRAM passwords before it starts`.

- **No database port on macOS and Linux.** The embedded server now listens
  only on a Unix socket in `<app data>/pg-socket` (owner-only; a private
  temporary directory when that path is too long for a socket), not on
  `127.0.0.1`. External tools can no longer connect to the embedded
  database: both passwords stay encrypted inside the app and no supported
  path hands them out (a follow-up in `docs/middleware-agent-handoff.md`
  §13 tracks an operator export if that is ever needed). Windows keeps
  `127.0.0.1`.
- **Rolling back** to an earlier desktop build: that build connects without a
  password and cannot open the migrated cluster. Before starting it, restore
  the pre-update snapshot the updater took: `snapshots/pgdata-pre-<version>-<stamp>/`
  as `pgdata/`, and its `.secrets.enc` as `secrets.enc`.
- **A snapshot restored without its `.secrets.enc`**, or a lost `secrets.enc`:
  the next start re-provisions the database passwords with the server stopped
  (single-user mode, no port open) and logs it at warn level. The kernel-vault
  caveat in `desktop/README.md` § Secrets and recovery still applies.

## Upgrading past v0.167.11 — answer check and tool errors behind the Privacy Shield, Excel formulas

Nothing to migrate: no schema change and no new variable. What an operator
notices ([`security-architecture.md`](security-architecture.md) §5a, §6c and
§6e have the full policy):

### The chat's completion waits for the answer verifier

Applies to instances that run both the privacy plugin and the answer verifier
(`VERIFIER_ENABLED`). The behaviour changes on update:

- **Streaming completion waits for the verifier.** The streamed text appears
  as before, but the final `done` event — the chat's "finished" state and the
  privacy receipt — arrives after the verifier's one to three model requests.
  Heartbeats keep the connection open meanwhile. API clients that read the
  receipt from `done` get it there as before, now including the verifier.
- **More receipts.** A verified turn now always has a receipt row, even when
  the verifier's requests were the only privacy-relevant event of the turn
  (new field `verifierEgress`, shown as "Answer check" in the web UI).
- **Fewer blocks and retries, never raw retries.** A contradiction the evidence
  judge found on placeholder values shows as a disclaimer instead of blocking;
  in enforce mode a correction retry is skipped (badge "failed") when its hint
  would have to carry masked values. Server-rendered table answers and Direct
  Line relays are no longer verified.

### Tool errors reach the model as withheld notices

- **Tool error text moved from the chat to the log.** When a tool throws, the
  model and the chat's tool card now see
  ``Error: tool `<name>` failed with <ErrorClass> (code <code>) [ref <ref>] …``
  instead of the driver or ORM message. The message, with its stack, is in the
  middleware log under the same ref (`grep 'ref=<ref>'`); on the chat path the
  ref is the turn's correlation id. A tool's *returned* `Error:` text still
  reaches the model, with personal data masked as `[masked:<type>]`, unless it
  looks like a record dump or a stack trace; then it is withheld and logged the
  same way. A failed `web_search` or `render_diagram` call shows the provider
  or diagram kind, the HTTP status and a ref; the upstream response and a
  connection error are in the log under that ref.
- **More receipt rows.** A turn whose only privacy-shield activity was a
  failing tool now writes a receipt (`/operator/receipts`), reaped by
  `RECEIPT_RETENTION_DAYS` as before.
- **A sub-agent does not repeat a call that ended in an exception.** The call
  may have taken effect before it failed, so a second identical call (same
  tool, same input) in the same sub-agent run gets
  ``Error: tool `<name>` was not called: …`` instead of running. A run trace
  shows that refusal where it used to show a second attempt.
- **Public MCP: a domain tool's sub-agent now works on masked data.** When an
  API key calls an `ask_<agent>` tool, that agent's sub-agent runs under the
  call's privacy gate: its model reads masked tool results and withheld error
  notices, as it does in chat, where before it read them in clear. Answers to
  API-key callers can differ from before. Nothing to configure.

For plugin authors: a tool that catches an exception should return
`toolErrorFromException(toolName, err)` (`@omadia/plugin-api` 1.20.0) instead
of `Error: ${err.message}`. Only text the plugin authors itself belongs in an
`Error:` result, and the dispatch seam redacts even that. A typed error class
of your own does not make its message authored text: keep a caught exception
on `cause` and an upstream response body on a separate field, and build the
`Error:` result from typed fields such as an HTTP status. The withheld notice
tells the model the call's outcome is unknown, and a sub-agent will not repeat
a call that ended with it; a tool whose failure is safe to retry (a read that
timed out) can return an `Error:` hint it writes itself instead. A tool that
returns an MCP connect prompt it wrote itself (text starting
`🔒 The MCP server "`) now has it interned like any other result: only the
prompt `McpManager` produced in the same dispatch reaches the model unchanged.
To surface one, call the MCP server through `ctx.mcp` and return its answer as
it is.

### The privacy guard pairs with this release

Tool-error redaction and the verifier's evidence projection need
`@omadia/plugin-privacy-guard` 0.6.0, which ships bundled with this release, so
a standard install has nothing to do. The plugin is not on the Hub, and a ZIP
with its id is refused unless `PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE=1` is set. An
older copy is therefore only active where someone put it in place of the
bundled one. With such a copy, or with another `privacy.redact@1` provider that
lacks the new methods, the kernel withholds every returned `Error:` text
entirely, every evidence-judge request fails closed (claims stay unverified),
and a second answer whose placeholders the model reworded is no longer held
back. The middleware log then shows `does not implement redactToolErrorText`
once per process. Upload a 0.6.0 or later build over that copy (with the same
`PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE=1` that admitted it): a version-change
upload keeps the installed entry and carries its settings over. Removing the
copy instead takes four steps, and no privacy shield runs between the second
and the third — no redaction, no masking, no receipts:

1. Note `mask_user_prompt`, the deny-lists and the C1 detector URL.
2. Uninstall the plugin, then delete its package (deleting while it is
   installed is refused with 409 `package.still_installed`).
3. Install the bundled plugin from the Store, or restart the middleware.
4. Enter the settings from step 1 again; the bundled plugin starts with its
   defaults.

Plugins built against `@omadia/plugin-api` < 1.20 keep working: the new
service methods are optional.

### Excel exports: the application that opens the file computes the formulas

`create_xlsx` (`@omadia/plugin-office` 0.1.4, bundled with the middleware)
writes formula cells without a cached result and marks a workbook that holds a
formula for a full recalculation on open. Excel, LibreOffice or Google Sheets
compute every figure when they open the file; omadia evaluates no formula
itself, and a `result` the model sends with a formula is ignored.

- **Previews show formula cells empty.** Viewers that do not calculate (Quick
  Look, Teams and Outlook previews, Excel's Protected View) show them empty
  until the file is opened for editing. A generated workbook uploaded as a
  dataset without being saved in Excel first imports those cells as empty.
- **Formulas that reach outside the workbook are refused.** A formula may only
  call Excel's own worksheet functions by their English names and compute over
  cells of this workbook. A URL fetch (`WEBSERVICE`, `IMPORTXML`, …),
  `INDIRECT`, `HYPERLINK`, DDE, add-in functions, localised names such as
  `SUMMEWENNS`, or a reference to another file makes the call fail: no file is
  written, and the tool answers with an `Error:` naming the cell and the
  reason, so the model can correct the formula.
- An installation that runs a Hub copy of the plugin gets this once 0.1.4 is
  published to the Hub. That publish is a separate step and still open
  (handoff §13).

## Upgrading past v0.167.10 — password sign-in is rate-limited

**Nothing to do for most installs.** The defaults are safe on every shipped
topology. What changes for operators:

- **The defaults.** `AUTH_LOGIN_CLIENT_ADDRESS=socket`: the limiter keys a
  client by the TCP peer, which nobody can forge. Behind a reverse proxy that
  peer is the proxy, so every browser shares one address bucket; the limiter
  knows that and never brakes such a shared address as one client. When a
  proxy in front appends the client's address to `X-Forwarded-For`, set
  `xff:<n>`, n being the number of trusted hops counted from the right. On
  Fly.io the setting is `header:Fly-Client-IP`, not `xff:1` (see below).
  `AUTH_LOGIN_MAX_INFLIGHT=4` concurrent argon2 runs and 300 attempts a minute
  are the global capacity; beyond it the server answers 503 `auth.busy`.
- **Refusals instead of endless tries.** After five wrong passwords for one
  account from one client, further attempts wait (1 s, doubling, at most
  2 minutes) and answer 429 `auth.rate_limited`. A busy server answers 503
  `auth.busy`. Both carry `Retry-After`; scripted sign-ins
  (`curl … /api/v1/auth/login/local`) should honour it. Every spelling of an
  address counts as that one account: letter case, accents and the like
  open no second budget.
- **Known devices are not locked out.** A browser that has signed in to an
  account with its password is one of that account's known devices. Wrong
  guesses and floods from clients that have not signed in to the account use
  up neither its sign-in budget nor its reserved share of the capacity, so it
  still signs in with the correct password while they are refused.
- **Unlocking an account.** A successful sign-in, an admin's password reset or
  re-enabling the user clears the wait. When no admin session is available,
  restart the middleware: the limiter lives in memory and a restart clears it.
- **A new cookie.** A successful password sign-in (and the first-user
  wizard) sets `omadia_login_device`, once per sign-in, for the account that
  signed in. It makes that browser one of the account's known browsers: they
  share a sign-in budget of their own and a reserved share of the sign-in
  capacity. A session alone does not set it, so browsers that are signed in
  when the new version starts become known browsers at their next password
  sign-in. It authenticates nothing and survives logout. It is tied to the
  password its sign-in checked: after a password reset, a disable or a
  delete it no longer counts, not even when that sign-in was still being
  checked as the reset landed, and only a sign-in with the current password
  sets one that counts. Rotating the session signing key (the vault entry
  `core:auth/session_signing_key`) ends every such cookie and every session
  at once.
- **The first-user wizard shares the capacity.** Its password hash takes a
  slot of the same global capacity, so it can answer 503 `auth.busy` too;
  retrying after `Retry-After` is enough.
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
<middleware-app>`. This holds only while web-ui's `MIDDLEWARE_URL` points
at the middleware's `.internal` address, as `fly/deploy.sh` sets it. Through
a `.flycast` address, Fly's proxy would most likely set the header to
web-ui's own address, and every browser behind web-ui would share one client
key (`docs/security-architecture.md` §10m).

**Render.** The blueprint (`render.yaml`) keeps the default `socket`. web-ui
reaches the middleware through the middleware's public URL, so a request
through web-ui passes more proxies than one sent to the middleware directly,
and no single `xff:<n>` picks the browser's address on both paths. Under
`socket` every browser shares one key, which the limiter treats as shared;
known devices keep their own budget.

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

## Upgrading past v0.167.9 — sessions, canvas sockets, setup token, routine card buttons

Four hardening changes an operator may notice. Two can need action: an
install whose first-user wizard is still open (no admin exists yet) needs the
setup token the middleware prints to its log, and an install whose Teams
channel plugin is older than 0.26.1 needs that plugin updated before routine
card buttons work again.

### Signing out ends every session of that user

No action needed; this section is about behaviour you will notice.

- **Sign-out is server-side and account-wide.** Signing out ends every session
  of that user, on every device, not only the one in this browser. So do an
  admin password reset and disabling a user. A copied cookie stops working on
  the next request instead of at its expiry. Resetting your own password signs
  you out as well.
- **One new auth migration** (`0003_users_session_version.sql`) adds a
  `session_version` column to `users`. It is additive and runs at boot like
  every other migration, and existing sessions stay valid through the upgrade.
- **The new check needs Postgres, and an outage is not a sign-out.** Every
  authenticated request now reads the user's row. While that read fails, API
  calls answer 503 `auth.unavailable` and the UI keeps you signed in and
  retries; it does not bounce you to the login page.
- **Open canvas connections end with the session.** The desktop canvas
  WebSocket is closed with code 4401 when the cookie that opened it expires
  (at most 4 hours after sign-in or the last renewal) and with 4403 when the
  session is revoked. A socket in use is re-checked before its next message
  once its last check is older than `WS_SESSION_FRAME_RECHECK_MS` (new,
  optional, default 5000 ms; 0 checks every message), an idle one every 60
  seconds. While the database cannot be read, canvas requests are refused
  with an error the user can retry, and the connection stays open. Clients
  built on `@omadia/canvas-core` 0.2.0 or later stop and ask to renew or sign
  in; older clients keep reconnecting into a 401 until the user signs in
  again. Renewing the session in the browser does not extend a socket that is
  already open: the client reconnects with the renewed cookie.
- Rotating the session signing key is still the lever for signing out *every*
  user at once.

### The first-user wizard asks for a setup token

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
The desktop app needs no token: its supervisor sets `OMADIA_DESKTOP_EMBEDDED`
together with a loopback bind, and only that pair is exempt. Either half on
its own still asks for the token.

Two behaviour changes worth knowing:

- **Scripted setup** (`curl … /api/v1/auth/setup`) must send the token as the
  `setup_token` JSON field. Without it the answer is 403
  `auth.setup_token_invalid`. There is no header variant.
- **Emptying the `users` table does not reopen the wizard on the running
  process any more.** A process that started with users answers 410
  `auth.setup_locked` while any exist, as before, and 410
  `auth.setup_disabled` once the table is empty, until the middleware
  restarts. It used to create an admin anyway. Restart, then open the wizard.

Parallel wizard submissions now create exactly one admin. A late one gets 410
`auth.setup_locked`, and one that collides with a slow database gets 409
`auth.setup_in_progress`, which is safe to retry.

### Routine card buttons need channel-teams 0.26.1 or later

The buttons on a routine card in Teams (Pausieren, Aktivieren, Löschen, Jetzt
auslösen) now act only for the user who clicked them, and the middleware refuses
a click whose channel plugin does not say who that was. The Teams channel plugin
(`@omadia/channel-teams`) sends that identity since **0.26.1**.

- With channel-teams 0.26.1 or later, nothing changes.
- With an older channel-teams, every routine card button answers *"Konnte die
  Routine nicht …: Keine Benutzeridentität für diese Karten-Aktion übermittelt …"*
  until the plugin is updated. Update it from the Hub before or right after the
  middleware. Routines keep firing on schedule in the meantime, and the Operator
  UI's Routines page can still pause, resume and delete them.
- Each refused click is logged at error level as `[security] REFUSED routine card
  action …`. If those lines keep appearing after the update, some channel plugin
  still sends clicks without the user's identity.

## Upgrading past v0.167.7 — self-update overlay, framing, web-ui user, sandbox limits

Four hardening changes an operator may notice. None needs action on a
default install. On an install that runs the self-update overlay
(`docker-compose.update.yaml`), the first one does, and Admin → Update cannot
apply it.

- **The self-update overlay needs one `up` by hand.** The overlay now puts
  `docker-socket-proxy` on its own internal network, `omadia-control`, and the
  updater's health gate no longer follows redirects. Admin → Update cannot
  apply either: the updater replaces the middleware and web-ui, never the
  compose files, the proxy or itself. Until compose re-applies the overlay,
  the proxy stays on `omadia`, where the middleware (plugins included), the
  web-ui and every sidecar can reach it, and whatever reaches it controls the
  host. Pull the new compose files, then run `up` with both files, plus
  every other overlay you use:

  ```bash
  docker compose -f docker-compose.yaml -f docker-compose.update.yaml up -d
  ```

  On a manual upgrade, this is step 4 of the general steps. If you upgrade
  through Admin → Update, run it by hand afterwards; it also restarts the
  middleware and web-ui once, on the images they already run. Then run the
  [control-network check](#checking-the-control-network): only `PASS` shows
  that the proxy is out of reach. Details:
  [Already running the overlay](#already-running-the-overlay).
- **Operator pages can no longer be framed.** Every operator page now sends
  `Content-Security-Policy: frame-ancestors 'none'` and
  `X-Frame-Options: DENY`. Plugin UIs and Teams tabs under `/p/*`, and
  everything under `/bot-api/*`, are unchanged. If you embed operator pages in
  another site (an intranet portal, a custom Teams tab pointing at `/chat`), set
  `UI_FRAME_ANCESTORS` on the **web-ui** service to the allowed origins, with
  the whole value in double quotes:

  ```bash
  UI_FRAME_ANCESTORS="'self' https://portal.example.com"
  ```

  It is read per request, so the published image picks it up on restart
  without a rebuild.
- **The web-ui container runs as `node` (uid 1000).** The shipped compose, Fly
  and Render setups mount nothing into it, so nothing changes there. If you
  mount a volume into the web-ui container yourself, make it writable for
  uid 1000. The self-updater recreates the container with the new image's
  user.
- **Sandbox containers have ceilings.** With `sandbox_execute_enabled` or
  `sandbox_publish_enabled` on, every container that runs agent code is capped
  at 512 MiB (swap included), 1 CPU and 256 processes. A heavier job, such as
  a large build, is now killed or throttled instead of competing with the
  middleware for the host. Raise the orchestrator setup fields
  `sandbox_memory_mb`, `sandbox_cpus` and `sandbox_pids_limit`, or set
  `OMADIA_SANDBOX_MEMORY_MB`, `OMADIA_SANDBOX_CPUS` and
  `OMADIA_SANDBOX_PIDS_LIMIT` on the middleware, within 6 to 1048576 MiB,
  0.01 to 1024 CPUs and 1 to 4194304 processes. There is no "unlimited": a
  value outside those ranges is ignored and the default applies, because
  Docker would run some of them (such as 0.000001 CPUs) with no limit at all.
  Existing persistent sandboxes get the limits the next time they are used;
  apps published before the upgrade keep running without them until you
  publish a new version.

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
