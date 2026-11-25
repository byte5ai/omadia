# 0057 — Builder builds run as a host child process over one shared build template, behind a coalescing queue

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main)
- **Supersedes:** —

## Context and Problem Statement

Every preview rebuild, every `fill_slot` check and every install of a Plugin Builder draft
needs `tsc` and a ZIP. The middleware runs as one process on one machine with a data volume
(Fly, compose, desktop). An `npm install` per build is too slow on a cold machine, and a spec
edited in a chat produces builds faster than they finish.

This record is retroactive. Where do Builder builds run, where do their dependencies come from,
and what happens when builds pile up?

## Decision Drivers

- A rebuild after a spec edit must be fast enough for a live preview.
- No container runtime may be required to use the Builder (desktop, single VM).
- A build must never hang or flood the process (time, output, concurrency).
- The latest spec wins; an install must not be cancelled by a preview rebuild.

## Considered Options

- **A — `node scripts/build-zip.mjs` as a child process in a staging directory whose
  `node_modules` is a symlink to one shared, hash-checked build template; one global queue**
- **B — A container per build** (Docker, like the agent sandbox)
- **C — `npm install` per staging directory**
- **D — Compile in-process with the TypeScript API**

## Decision Outcome

Chosen option: **A**.

- **One build template.** `ensureBuildTemplate` (`buildTemplate.ts`) keeps
  `data/builder/build-template/node_modules`: npm dependencies derived from the boilerplate's
  `package.json` (`buildTemplateConfig.ts`) installed once with `npm install --omit=dev`,
  workspace packages symlinked from `middleware/packages/`. A content hash
  (`.harness-build-template.hash`) makes the boot step a no-op when nothing changed. Service-type
  packages of active integrations are linked in at activation and reconciled at boot.
- **Staging per build.** `prepareStagingDir` writes the codegen file map under
  `data/builder/staging/` and links the template's `node_modules`; the directory is always
  removed afterwards (`buildPipeline.ts`).
- **The build is a child process, not a sandbox in the security sense.** `buildSandbox.ts`
  spawns `node scripts/build-zip.mjs` with `cwd` = staging directory, a 45 s timeout, 2 MB caps
  on stdout and stderr and an `AbortSignal`. The slot type check (`typecheck.ts`) calls the
  `tsc` binary directly (`--noEmit`, 30 s), not `npx`. A `tsc` failure is a result
  (`BuildResult { ok: false, errors }`), not an exception.
- **One queue for all builds.** `BuildQueue`: FIFO, concurrency 3, coalescing per key. A new
  entry with the same key aborts the queued or running one; the key defaults to the draft id
  (latest spec wins). Install and manual rebuild use their own key (`<draftId>:install`), so a
  debounced preview rebuild (2 s, `previewRebuildScheduler.ts`) cannot cancel them.
  `drain(timeoutMs)` ends builds on shutdown.
- **Build failures are typed.** `tsc`, `zip_missing`, `package_json_missing`, `timeout`,
  `abort`, `spawn`, `unknown`; pipeline errors `draft_not_found`, `spec_invalid`,
  `codegen_failed`, `template_not_ready`, `staging_failed`.

### Consequences

- 🟢 **Good:** A build costs one `tsc` run; no install, no container start.
- 🟢 **Good:** The Builder works wherever the middleware runs with Node and a writable data
  directory.
- 🟢 **Good:** Stale rebuilds drop instead of queueing behind each other.
- 🔴 **Bad:** The name `BuildSandbox` promises more than it does. The child inherits the
  middleware's environment (`env: process.env` in `buildSandbox.ts`) and file system; the only
  limits are time, output size and concurrency. This is acceptable only because the build runs
  the fixed boilerplate script and `tsc` over generated sources and does not execute slot code.
  Slot code first runs in the preview ([ADR-0059](0059-builder-preview-in-process-with-captured-tools.md)).
- 🔴 **Bad:** All generated plugins share one dependency set; a package missing from the
  template fails at `tsc`, and the boot-time `npm install` (120 s) needs registry access once.
- 🔴 **Bad:** Queue state is in memory and per process; a restart drops running builds.
- ⚪ **Neutral:** The first preview build waits on the `templateReady` promise instead of
  failing with a missing `node_modules`.

## Pros and Cons of the Options

### A — Child process, shared template, queue

- 🟢 Fast, no extra infrastructure.
- 🔴 No isolation beyond limits; shared dependency set.

### B — Container per build

- 🟢 Real isolation of the toolchain.
- 🔴 Needs a container runtime on every deployment, which the desktop app and the Fly machine
  do not offer to the middleware process; slower.

### C — Install per build

- 🟢 Per-plugin dependencies.
- 🔴 Tens of seconds per build and registry traffic on every edit.

### D — In-process compile

- 🟢 No spawn.
- 🔴 A compiler fault or a long type check blocks the event loop of the kernel.

## More Information

- Related: [ADR-0064](0064-plugin-builder-spec-and-slots-into-boilerplate-templates.md),
  [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md), [ADR-0055](0055-agent-computer-is-a-docker-sandbox-per-scope.md)
  (the container sandbox for agent code, a different mechanism).
- Paths: `middleware/src/plugins/builder/{buildTemplate,buildTemplateConfig,buildPipeline,buildQueue,buildSandbox,typecheck,slotTypecheckPipeline,previewRebuildScheduler}.ts`,
  `middleware/src/platform/paths.ts` (`BUILDER_*_DIR`).
- Tests: `middleware/test/builder/{buildTemplate,buildTemplateConfig,buildPipeline,buildQueue,buildSandbox,typecheck,slotTypecheckPipeline,previewRebuildScheduler}.test.ts`.
