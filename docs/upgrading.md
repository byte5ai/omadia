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

## Answer verifier: `enforce` withholds what it could not confirm (releases after 2026-10-01)

No configuration step: no new environment variable, no migration. It matters
only if the verifier runs in `enforce` mode (`VERIFIER_ENABLED=true` and
`VERIFIER_MODE=enforce`, or the `verifier_enabled` / `verifier_mode` setup
fields of `@omadia/verifier`); `shadow` behaves exactly as before.

- **Answers the verifier could not confirm are withheld.** `enforce` delivers
  an answer only when its verdict is `approved`, or `skipped` because the
  answer holds nothing to check (no figure, date or reference, or no claim).
  Every other verdict replaces the answer with a short notice in the operator's
  disclosure locale: a contradiction, but also a partly confirmed answer, an
  answer whose claims no checker takes, and a turn in which the verifier could
  not run. An answer longer than the 6000 characters the claim extractor reads
  is never fully covered and is therefore always withheld. Before switching,
  run `shadow` and compare: the share of `verifier_verdicts` rows with status
  `approved`, or `skipped` with reason `no_trigger` / `no_claims`, is the share
  of answers `enforce` would deliver.
- **Streaming clients wait for the verdict.** On `/api/chat/stream`, the
  public API-key stream and the canvas, no answer text arrives before the turn
  and its verification (two LLM calls plus the source checks) have finished;
  then the whole answer arrives at once, as a single text delta. The canvas
  skeleton waits too: it appears with a released answer and not at all with
  a withheld one. A turn without tool calls sends only its start events
  (routing, iteration start) in between on the API-key stream — give API
  clients a read timeout that covers a full turn plus verification.
- **Teams and Telegram** now show the notice instead of an answer that is
  still contradicted after the correction retry (previously delivered with a
  "contradiction found" badge). The retry itself is unchanged and runs only on
  this non-streaming path; `VERIFIER_MAX_RETRIES` keeps its default of 1. An
  answer that ends with `NO_REPLY` after other text is checked like any
  answer; when the verifier withholds it, the channel posts the notice
  instead of staying silent.
- **API clients** that switch exhaustively over `done.answerSource` must
  handle `"verifier-blocked"` (always with `answerIsError: true`; `answer` is
  the notice). A client that renders `done.answer` needs no change.
  `done.verifier` now carries the verdict in `enforce` mode; the trailing
  `verifier` event is still sent. Plugins compiled against
  `@omadia/channel-sdk`'s `AnswerSource` type see the widened union.
- **Not covered:** agents on the subscription-CLI runtime (`claude-cli`
  provider) and proactive routines are not verified, whatever the mode.

## Answer verifier: `skipped` and `unavailable` verdicts (releases after 2026-09-30)

No configuration step: no new environment variable, no migration. It matters
only if the verifier is enabled (`VERIFIER_ENABLED=true`) and something reads
its results:

- **SQL on `verifier_verdicts`.** `status` now also holds `skipped` (nothing
  checkable in the answer) and `unavailable` (the verifier could not run).
  Both used to be stored as `approved`, so the share of `approved` rows drops.
  It drops further because an answer the verifier could check only in part
  (a claim no checker accepts, more claims than `VERIFIER_MAX_CLAIMS`, an
  answer longer than the 6000 characters the claim extractor reads, or a
  claim the extraction returned that is not in the answer or longer than 300
  characters) is now
  `approved_with_disclaimer`, its unchecked claims and coverage entries
  counted in `unverified_count`, which now always counts every unverified
  claim of the row. A dashboard or query that reads
  `status = 'approved'` as "clean turn" is now correct, but its numbers
  change.
- **Clients of the `verifier` stream event** (`/api/chat/stream`, public API
  keys). `summary.status` can be `skipped` / `unavailable`, `summary.badge`
  `unverified` / `unavailable`, and a `summary.reason` code,
  `summary.uncheckedCount` and `summary.uncoveredCount` appear. The badge is
  `unverified` or `unavailable` whenever no claim was confirmed or
  contradicted — also on an `approved_with_disclaimer` status — so key on the
  badge, not on the status. Show a result as checked only for `verified` /
  `partial` / `corrected` / `failed` with `claimCount > 0`; `corrected`, like
  `verified`, now means every claim was confirmed.
- **`VERIFIER_MAX_CLAIMS`** keeps its value and default (20) and caps how many
  claims are checked per answer. Claims beyond it are no longer dropped; they
  are reported as not checked. The claim extractor asks the model for one
  claim more than the cap and reports a list that reaches that limit as
  possibly incomplete, so a model that stops at the limit cannot hide claims
  either. Both keep the answer at "partly verified".
- **Plugins built against `@omadia/verifier` types.** A `switch` over
  `VerifierVerdict['status']` must handle the two new statuses before it
  compiles again. An `unverified` claim verdict may carry
  `cause: 'not_checked' | 'check_failed'`, and a claim may have the synthetic
  type `coverage_gap`. `ClaimExtractor.extract` now resolves
  `{ claims, gaps }` instead of a claim list, returns every valid claim
  instead of cutting the list at `maxClaims`, reads every `record_claims`
  call of the model's response, and names in `gaps` what it did not cover —
  including claims that are not in the answer (`claims_not_in_answer`), which
  it used to drop without a trace, and claims longer than `MAX_CLAIM_CHARS`
  (300; `claims_too_long`), which it used to cut to their first 300
  characters before checking them. A claim's `text` is the span of the
  answer it quotes (case and whitespace may differ from the model's text),
  never longer than `MAX_CLAIM_CHARS`. A `switch` over `ExtractionGap` must
  handle `claims_too_long`. Give `VerifierPipeline` the same `maxClaims` to
  cap the checks. A plugin that provides its own `verifier@1` pipeline gets
  its verdict held to its claims (`bindVerdictToClaims`): a status its claims
  do not back is lowered, and `approved` over no claim, an unknown status or
  a `reason` outside the closed codes is reported as `unavailable` /
  `pipeline_error`.

Teams and Telegram need nothing: they keep receiving only the four badges they
know and show no badge for turns without evidence.

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
