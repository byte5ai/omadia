# 0154 — The desktop app is an Electron shell that supervises the unmodified kernel and web-ui on a bundled PostgreSQL

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from `desktop/README.md` and
  `desktop/src/`; CI job for the shell from #932)

## Context and Problem Statement

This record is retroactive: it documents a design that is implemented on main.

omadia's server install needs Docker, a Postgres with pgvector and two master keys. The
desktop app is the native, no-Docker way to run the full stack locally (`desktop/README.md`):
an installer for macOS, Windows and Linux with no database to install. Is the desktop
app a second implementation of omadia, or the same kernel and UI in a different wrapper, and
what does it use as its database?

## Decision Drivers

- One codebase: no desktop fork of the kernel, its migrations or the web-ui.
- No prerequisites on the user's machine, including no Node runtime.
- The kernel's real query load and its `pg` connection pools must work.
- A single-user machine has different defaults from a server on a LAN.

## Considered Options

- **A — Electron shell that forks the built kernel and web-ui as child processes and runs a
  bundled native PostgreSQL 17 + pgvector.**
- **B — The same shell on PGlite (Postgres compiled to WASM) behind `pglite-socket`.**
- **C — A desktop wrapper that drives Docker Desktop.**
- **D — Kernel and UI compiled into the Electron main process, with SQLite.**

## Decision Outcome

Chosen option: **A**.

- **Supervisor, not reimplementation.** `desktop/src/supervisor.ts` owns the lifecycle
  embedded DB → kernel → web-ui. Kernel and web-ui are the ordinary builds (`middleware/dist`,
  Next `output: 'standalone'`), staged by `desktop/scripts/stage-runtime.mjs` and shipped as
  unpacked `extraResources`, outside the asar, so they can be executed.
- **No separate Node.** Children are forked from Electron's own binary with
  `ELECTRON_RUN_AS_NODE=1`. The kernel therefore runs on Electron's embedded Node (24 since
  Electron 44), while servers, CI and development run it on Node 22.
- **A real PostgreSQL.** `desktop/src/embeddedDb.ts` drives bundled `initdb`/`postgres`
  binaries and pgvector directly (staged to `resourcesPath/omadia-pg`). The kernel connects
  through its normal `DATABASE_URL` path and runs all existing migrations.
- **The shell tells the kernel what it is, through env.** `NODE_ENV=production`,
  `HOST=127.0.0.1`, `OMADIA_DESKTOP_EMBEDDED=true`, `OMADIA_EMBEDDED_DB=1` (the live DSN wins
  over the copy in the vault), `OMADIA_DB_REQUIRE_SCRAM=1`, `OMADIA_VERSION=v<app version>`
  and `BUILT_IN_PACKAGES_DIR` for the packaged app. `OMADIA_DESKTOP_EMBEDDED` and
  `OMADIA_DB_REQUIRE_SCRAM` are set after `...process.env` on purpose: they are facts about
  how the shell runs the kernel, not preferences an inherited value may override.
- **Desktop defaults differ where a single machine demands it.**
  `desktop/src/kernelEnvDefaults.ts` turns the kernel's mDNS advertiser off unless the user set
  it; an explicit user value wins.
- **Lifecycle rules.** One start/restart/stop runs at a time; a generation token keeps
  intentionally killed children from being reported as crashes; quit blocks until the database
  is flushed and closed. One `BrowserWindow`; every navigation goes through the arbiter in
  `desktop/src/shellView.ts`, so a finishing boot cannot overwrite an open wizard.
- **Setup counts only after a successful boot.** A failed first boot offers "Re-run setup"
  instead of a boot loop.

### Consequences

- 🟢 **Good:** Every kernel and UI change reaches the desktop app without porting.
- 🟢 **Good:** Full SQL compatibility and real pooling; no database to install.
- 🔴 **Bad:** The installer carries a Postgres engine of roughly 130 MB
  (`desktop/electron-builder.yml`) and native modules per architecture, which rules out a
  universal macOS binary (see [ADR-0152](0152-desktop-installers-signing-and-auto-update.md)).
- 🔴 **Bad:** Two Node majors run the same kernel. On Electron's Node the kernel is checked
  only by the native-module load step and by starting a built app; no CI job runs its test
  suite there (`docs/security-architecture.md` §4a).
- 🔴 **Bad, accepted for v1:** Secrets reach the kernel through the child environment,
  readable by same-user processes; free-port selection has a TOCTOU window
  (`desktop/README.md`, "Accepted v1 limitations").
- ⚪ **Neutral:** Middleware code branches on `OMADIA_DESKTOP_EMBEDDED` in a few places (the
  first-user setup token, `update/platform.ts`).

## Pros and Cons of the Options

### A — Supervised unmodified stack on native Postgres

- 🟢 One codebase, real database.
- 🔴 Large installer, per-architecture builds.

### B — PGlite

- 🟢 Small, no native binaries.
- 🔴 Tried first: the WASM engine crashed (`RuntimeError: unreachable`) under the kernel's
  query load and `pglite-socket` serves one connection (`desktop/src/embeddedDb.ts`).

### C — Drive Docker Desktop

- 🟢 Identical to the server stack.
- 🔴 Docker is exactly the prerequisite the installer exists to remove.

### D — In-process kernel on SQLite

- 🟢 One process.
- 🔴 A second storage backend and a fork of every migration.

## More Information

- Docs: `desktop/README.md`.
- Code: `desktop/src/supervisor.ts`, `desktop/src/embeddedDb.ts`,
  `desktop/src/embeddedDbEngine.ts`, `desktop/src/kernelEnvDefaults.ts`,
  `desktop/src/shellView.ts`, `desktop/scripts/stage-runtime.mjs`.
- Tests: `desktop/test/supervisorLifecycle.test.mts`, `supervisorKernelEnv.test.mts`,
  `shellView.test.mts`, `embeddedDb.integration.test.mts`; the `desktop` job in
  `.github/workflows/ci.yml`.
- Related drafts: [ADR-0153](0153-desktop-secret-custody-and-shell-trust-boundaries.md),
  [ADR-0152](0152-desktop-installers-signing-and-auto-update.md).
