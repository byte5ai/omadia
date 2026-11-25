# 0156 — Self-update is notify-only by default; applying one is an opt-in sidecar, gated on the new version's health

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively; issue #432, Fly engine #696,
  trust model in `docs/security-architecture.md` §10f)

## Context and Problem Statement

This record is retroactive: it documents a design that is implemented on main.

A self-hosted install has to learn that a newer release exists, and issue #432 asked for a
way to apply it from the admin UI where the operator wants that. Replacing running
containers needs the Docker Engine API, and access to that API is equivalent to root on the
host. The middleware runs plugin code in-process. Who is allowed to replace the stack, how is
that capability kept away from application containers, and what happens when the new version
does not come up?

## Decision Drivers

- No self-host acquires host-root-equivalent capability by accident.
- No Docker socket in a container that runs plugin code.
- A failed update leaves a running instance, not a dead one.
- An update is an attributable operator action.
- Compose and Fly differ in mechanism, not in the rules.

## Considered Options

- **A — Notify-only by default; an opt-in updater sidecar behind a socket proxy on a separate
  internal network; health-gated with rollback.**
- **B — Mount the Docker socket into the middleware.**
- **C — An unattended auto-updater (Watchtower style).**
- **D — Notify only; the operator always updates by hand.**

## Decision Outcome

Chosen option: **A**.

- **Notify-only is the default.** `GET /api/v1/admin/update/status` always answers: running
  version, latest release from GitHub (cached 30 minutes, failures backed off, stale answers
  flagged; `middleware/src/update/releaseLookup.ts`), and platform. Without an updater,
  `POST` answers 409 and the page gives instructions.
- **Opt-in executor.** `docker-compose.update.yaml` adds `updater`
  (`ghcr.io/byte5ai/omadia-updater`, a zero-dependency `.mjs` service) and
  `docker-socket-proxy`. Setting `OMADIA_UPDATER_URL` on the middleware is what switches the
  admin page to update-capable.
- **Reachability is the boundary.** The socket is mounted into the proxy alone. The proxy
  joins only the `internal` network `omadia-control`, whose only other member is the updater.
  The proxy's flags shrink what a compromised updater can do; they are not a sandbox.
- **The updater's own guards.** A shared bearer token (at least 16 characters, refuses to
  start without one), release tags only (`vX.Y.Z`, floating tags rejected), and a hard-coded
  protected list: `postgres`, `updater`, `docker-socket-proxy`.
- **The trigger is confirmed and audited.** `POST /api/v1/admin/update` sits behind the session
  (`requireAuth`), requires the operator to retype the exact target tag (checked server-side),
  refuses without an audit store, and answers `202` without waiting, because the update
  recreates the container that serves the request. The UI polls status.
- **Sequence.** Resolve targets, pull every image before stopping anything, pin
  `OMADIA_VERSION` in the project-root `.env`, recreate each service from its own inspect
  output with only `Image` changed, then gate on the middleware's `/health` *reporting the new
  version* (default window 300 s, redirects not followed). On any failure: restore the pin and
  recreate the replaced containers on the previous image, in reverse order.
- **Engines.** Ordering, gate, rollback and the protected list live in `updateJob.mjs`. An
  engine owns only what differs: `docker` (default) and `fly` (Machines API, one app-scoped
  deploy token per managed app, no public address, `OMADIA_WITH_UPDATER=1` in
  `fly/deploy.sh`).
- **The desktop app is out of scope here.** It reports platform `desktop` and updates itself
  (see [ADR-0152](0152-desktop-installers-signing-and-auto-update.md)).

### Consequences

- 🟢 **Good:** The default stack has no component that can replace containers.
- 🟢 **Good:** A typo'd tag or a registry outage is found while the old stack is still up, and
  a version that never reports healthy is rolled back.
- 🔴 **Bad, accepted:** With the overlay on, the updater is host-root-equivalent, and anything
  that controls the middleware process (in-process plugins included) holds its token and can
  start an update to any release tag, an older one included (§10f).
- 🔴 **Bad:** Rollback does not undo schema migrations; they are forward-only and applied at
  boot, so a rolled-back image can meet a migrated database. Operators snapshot the Postgres
  volume before a major bump (`docs/upgrading.md`).
- 🔴 **Bad:** The Fly engine cannot persist the pin: a later `fly deploy` from the operator's
  local `fly.toml` overrides it (`canPersistPin: false`).
- ⚪ **Neutral:** A new version that needs a new boot secret fails the gate as
  `never_reachable` and rolls back; `docs/deployment.md` names this as the common case.

## Pros and Cons of the Options

### A — Opt-in isolated updater

- 🟢 Capability isolated and explicit; safe failure.
- 🔴 Two more containers and a second network; residual trust in the middleware.

### B — Socket in the middleware

- 🟢 No sidecar.
- 🔴 Every in-process plugin would be host root.

### C — Unattended auto-update

- 🟢 Always current.
- 🔴 No operator decision, no audit entry, and pre-1.0 releases may need manual migration steps.

### D — Notify only

- 🟢 No control plane at all.
- 🔴 Leaves the one-click path the issue asked for unbuilt; it remains the default.

## More Information

- Code: `middleware/sidecars/updater/` (`README.md`, `src/updateJob.mjs`, `src/engine/`),
  `middleware/src/update/`, `middleware/src/routes/adminUpdate.ts`,
  `docker-compose.update.yaml`, `fly/updater.fly.toml`.
- Tests: `middleware/sidecars/updater/test/*.test.mjs` (`npm run test:updater`),
  `middleware/test/adminUpdateRoute.test.ts`, `composeUpdateOverlay.test.ts`,
  `updateAuditStore.pg.test.ts`, `updateReleaseLookup.test.ts`.
- Docs: `docs/security-architecture.md` §10f, `docs/upgrading.md` ("Updating from the
  Operator UI").
- Related drafts: [ADR-0148](0148-build-stamp-is-the-version-of-record-and-health-reports-it.md),
  [ADR-0150](0150-compose-minimal-core-with-opt-in-overlays-and-prebuilt-images.md).
