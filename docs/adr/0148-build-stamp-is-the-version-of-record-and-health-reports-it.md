# 0148 — The build stamp `OMADIA_VERSION` is the running version; `/health` reports it without a session

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively; #432 slice 1 for the stamp, #1382
  for the web-ui `/health`, #665 and #1385 for the database verdict; the byte5 deploy script
  after the unstamped Fly deploys of October 2026)

## Context and Problem Statement

This record is retroactive: it documents a contract that is implemented on main.

Releases are git tags; `package.json` files are not bumped with them (see
[ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md)). `middleware/package.json` and
`web-ui/package.json` read `0.2.0` long after the release series had passed v0.74.0, and the
help page printed that number on every release. Three consumers need the true answer: a
person filing a support request, the admin page deciding whether a newer release exists, and
the updater deciding whether the image it just started is the one it asked for. Where does a
running process learn its version, and where does it publish it?

## Decision Drivers

- A wrong version is worse than no version.
- Machines (updater, deploy script, platform health checks) must read it before anyone has
  signed in.
- One mechanism for images, edge builds, local builds and the desktop app.
- `/health` must not hand an unauthenticated caller anything sensitive.

## Considered Options

- **A — Stamp the build with `OMADIA_VERSION` (build arg → image env); report `unknown` when
  unstamped; expose it on the public `/health` of both services.**
- **B — Read `package.json` and bump it on every release.**
- **C — An authenticated version endpoint only.**

## Decision Outcome

Chosen option: **A**.

- **One source.** `resolveAppVersion` (`middleware/src/update/version.ts`) and
  `web-ui/app/_lib/appVersion.ts` read the `OMADIA_VERSION` environment variable.
  `package.json` is deliberately not a fallback.
- **Three kinds.** `release` (a semver tag, comparable against GitHub), `floating` (`latest`,
  `edge`, `sha-<short>`: "newer release available" is undecidable) and `unknown` (unstamped).
- **Stamped at build.** `publish-images.yml` passes the release tag, or `sha-<short>` for an
  edge build, as the `OMADIA_VERSION` build arg; both Dockerfiles turn it into image `ENV` in
  the runtime stage. An empty arg prints a warning banner and does not fail the build, because
  a local `docker compose build` legitimately has no stamp.
- **Compose does not pass it through.** `OMADIA_VERSION` selects the image tag but is not
  listed under any service's `environment:`; passing it would override the baked stamp with an
  empty string when the variable is unset. The updater likewise drops a stale
  `OMADIA_VERSION` env entry when it recreates a container.
- **Desktop.** The shell sets `OMADIA_VERSION=v<app version>` for the packaged app
  (`desktop/src/kernelEnvDefaults.ts`); a dev run reports nothing.
- **`/health` contract, middleware.** Unauthenticated. `200` with `status: 'ok'`, or `503` with
  `status: 'error'` when the graph pool is dead. Body: `status`, `version`, `checks` (database
  verdict), `kg` (capability states), `disclosure` (AI-Act marking posture: levels and
  booleans only), `attachments` (backend kind only). New fields are additive: the updater's
  health gate and the desktop supervisor key on `status`, the HTTP code and `version`.
- **`/health` contract, web-ui.** Static liveness JSON `{status, service, version}`, rendered
  per request (`force-dynamic`), independent of the middleware being up, and on the login
  gate's public allowlist.
- **What `/health` never says.** Whether the master keys come from env or the dev file. That is
  on the authenticated `/api/v1/admin/vault-status`.
- **byte5's own Fly instance** is deployed only through `scripts/fly-deploy.sh`, which stamps
  `sha-<8>`, refuses a dirty or main checkout, holds a lock, and verifies afterwards that both
  apps report the target stamp on `/health`.

### Consequences

- 🟢 **Good:** "Which commit is live" has one answer a script can read.
- 🟢 **Good:** The self-update health gate can require the *new* version, not merely an answer.
- 🔴 **Bad, accepted:** The running release is visible to unauthenticated callers.
  `docs/security-architecture.md` §10g accepts this: release tags are public, and hiding the
  number would not hide a vulnerable build from someone probing behaviour.
- 🔴 **Bad:** An unstamped build is only warned about. Hand-typed `fly deploy` calls without the
  build arg shipped `version: "unknown"` in October 2026 (`docs/fly-deploy.md`).
- 🔴 **Bad:** `package.json` versions in the repo stay meaningless (`0.2.0`, desktop `0.1.0`)
  and mislead readers who look there first.
- ⚪ **Neutral:** `scripts/fly-deploy.sh` is specific to byte5's two Fly apps; the public
  installer is `fly/deploy.sh`.

## Pros and Cons of the Options

### A — Build stamp, `unknown` when absent, public `/health`

- 🟢 True by construction for every published image; machine-readable before login.
- 🔴 Depends on every build path passing the arg.

### B — `package.json`

- 🟢 Conventional.
- 🔴 Needs a commit per release on a protected `main`; it had already drifted to a
  "confidently wrong" value.

### C — Authenticated endpoint only

- 🟢 Nothing public.
- 🔴 The updater, platform health checks and the deploy script have no session.

## More Information

- Code: `middleware/src/update/version.ts`, `middleware/src/update/semver.ts`,
  `middleware/src/index.ts` (`app.get('/health', …)`), `web-ui/app/health/route.ts`,
  `web-ui/app/_lib/appVersion.ts`, `Dockerfile`, `web-ui/Dockerfile`,
  `.github/workflows/publish-images.yml`, `scripts/fly-deploy.sh`.
- Tests: `middleware/test/updateVersion.test.ts`, `middleware/sidecars/updater/test/health.test.mjs`.
- Docs: `docs/security-architecture.md` §8 ("Master-key posture is not on the public
  `/health`"), §10g; `docs/fly-deploy.md`.
- Related drafts: [ADR-0156](0156-operator-triggered-self-update-through-an-isolated-updater.md),
  [ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md).
