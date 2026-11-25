# 0150 — The self-hosted stack is a three-service core from prebuilt images; every optional feature is an overlay file

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Marcel Wege (author of `specs/336-minimal-onboarding-stack/spec.md`, issue
  #336); recorded retroactively. Later overlays: self-update #432, PII detector #361,
  SeaweedFS instead of MinIO #1506.

## Context and Problem Statement

This record is retroactive: it documents a topology that is implemented on main.

Before #336 the tracked `docker-compose.yaml` started nine services unconditionally and built
the middleware and the web-ui from source. A first `docker compose up -d` ran `npm ci`, `tsc`
and a Next.js build, then waited for a bucket provisioning step and a 270 MB model pull before
the kernel started. The README described opt-in profiles that did not exist. Spec 336 found
that the kernel already degrades cleanly without Ollama, object storage and Kroki: each is a
built-in plugin gated on an environment variable. What is the default self-hosted stack, how
are optional sidecars added, and how do the cloud targets relate to it?

## Decision Drivers

- First boot in about a minute on a cold clone, without a source build.
- Enabling a feature must start its sidecar *and* set the matching env on the always-on
  `middleware` service.
- No kernel change to get there.
- A local default must not become an unsafe public deployment by copy and paste.

## Considered Options

- **A — Minimal core plus override files, one per feature, composed with `-f`.**
- **B — One file with `profiles:` and `.env` toggles.**
- **C — Profiles with always-set env and a kernel that gates on reachability.**

## Decision Outcome

Chosen option: **A** (spec 336 §4, "Decision: Adopt Option A").

- **Core.** `docker-compose.yaml` starts `middleware`, `web-ui` and `postgres`
  (`pgvector/pgvector:pg17`) and nothing else.
- **Prebuilt images.** `ghcr.io/byte5ai/omadia-middleware` and `omadia-web-ui`, tagged
  `${OMADIA_VERSION:-latest}`, multi-arch (amd64, arm64). Building from source is itself an
  overlay (`docker-compose.build.yaml`).
- **One overlay per feature**, each adding its sidecar and the env that activates the plugin:
  `storage` (SeaweedFS), `diagrams` (Kroki, needs storage), `embeddings` (Ollama),
  `pii-detector`, `skillspector`, `update`. Without an overlay the feature reports itself
  unconfigured; it does not fail the boot.
- **Loopback by default.** All host ports bind to `127.0.0.1`. The compose file says not to
  expose the stack without an external reverse proxy and auth layer.
- **Two postures for the master keys.** The published image bakes `NODE_ENV=production`, in
  which the middleware refuses to boot without `VAULT_KEY` and `CREDENTIAL_KEYCHAIN_KEY`. The
  compose file overrides `NODE_ENV` to `development` so the dev fallback (keys on the data
  volume) keeps a local `up` configuration-free. A non-local deploy drops that override and
  sets both keys.
- **Dev endpoints are never hard-coded on.** `DEV_ENDPOINTS_ENABLED` stays out of the compose
  file and the cloud blueprints.
- **Cloud targets mirror the core.** `render.yaml` (one-click blueprint) and `fly/deploy.sh`
  (one command, three apps, private pgvector Postgres) provision the same three services from
  the same GHCR images and generate both keys. Overlays are not part of either.
- **Images drop privileges.** The middleware entrypoint chowns the mounted `/data` volume and
  then execs as `node` through `gosu`; the web-ui image mounts nothing and uses `USER node`.

### Consequences

- 🟢 **Good:** A cold install pulls three images; optional features cost nothing until chosen.
- 🟢 **Good:** One mechanism couples "start the sidecar" with "tell the kernel".
- 🔴 **Bad:** Multi-`-f` invocations are verbose, and a plain `docker compose up -d` later
  recreates `middleware` without any overlay's environment. `docs/upgrading.md` tells operators
  to list their files once in the project-root `.env`.
- 🔴 **Bad:** Overlay dependencies are documented, not enforced: `diagrams` without `storage`
  yields a half-configured plugin (named as a risk in spec 336).
- 🔴 **Bad, accepted:** The local default runs in `development` mode with master keys on the
  data volume. That is safe only because the ports are loopback-only.
- ⚪ **Neutral:** Compose uses `pg17`, the CI service container `pg16`. Render and Fly need paid
  instance types because the middleware needs a persistent disk.

## Pros and Cons of the Options

### A — Core plus override files

- 🟢 Each overlay is self-contained and additive; no kernel change.
- 🔴 Verbose; layering mistakes are possible.

### B — Profiles and `.env` toggles

- 🟢 One file.
- 🔴 Rejected in spec 336: two coupled manual steps (activate the profile and edit `.env`),
  because a profile cannot set env on a different, always-on service.

### C — Profiles with reachability gating

- 🟢 One file, one step.
- 🔴 Rejected for v1 in spec 336: requires kernel changes.

## More Information

- Spec: `specs/336-minimal-onboarding-stack/spec.md`, `plan.md`.
- Code: `docker-compose.yaml`, `docker-compose.*.yaml`, `Dockerfile`, `docker-entrypoint.sh`,
  `web-ui/Dockerfile`, `render.yaml`, `fly/deploy.sh`, `fly/*.fly.toml`,
  `middleware/compose.defaults.env`.
- Docs: `docs/deployment.md`, `docs/getting-started.md`, `docs/upgrading.md`.
- Tests: `middleware/test/composeUpdateOverlay.test.ts`; the CI steps "Compose — update
  overlay renders" and "Compose — overlay images are pullable" in `.github/workflows/ci.yml`.
- Related drafts: [ADR-0156](0156-operator-triggered-self-update-through-an-isolated-updater.md),
  [ADR-0148](0148-build-stamp-is-the-version-of-record-and-health-reports-it.md),
  [ADR-0161](0161-web-ui-same-origin-front-and-runtime-proxy.md).
