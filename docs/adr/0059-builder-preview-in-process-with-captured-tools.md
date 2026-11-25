# 0059 — A Builder preview activates the draft in-process; its tools are captured, its rights are those of its manifest

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); draft agent
  and service gate from #2143 / #2172 (spec 2042 §5.10, criterion 37)
- **Supersedes:** —

## Context and Problem Statement

An operator wants to try a draft plugin before installing it.
[ADR-0014](0014-plugins-are-only-the-delivery-form.md) already says a preview is a turn of a
`draft` agent in the admin UI only, and [ADR-0017](0017-model-gateway-and-execution-contexts.md)
that its model calls are an operator job. Neither says how the draft's code runs, what it may
reach, and what keeps a preview from becoming an install.

This record is retroactive. How is a draft plugin executed for a preview?

## Decision Drivers

- A preview must behave like the installed plugin, or it proves nothing.
- A preview must not add a tool, a route, a job or a secret to the running instance.
- A draft that depends on an installed integration must be testable against it.
- Switching between recent drafts must be fast.

## Considered Options

- **A — Activate the built ZIP in the kernel process with a preview context: registrations
  captured on a handle, platform services replaced or gated**
- **B — Install the draft for real, flagged as preview**
- **C — Run the draft in a separate process or container**

## Decision Outcome

Chosen option: **A** (`previewRuntime.ts`).

- **Captured, not registered.** Tools the draft registers through `ctx.tools.register` stay on
  the preview handle (`toolkit.tools`) and never reach the kernel's `NativeToolRegistry`; jobs
  are captured and never scheduled; `ctx.routes.register` is a no-op stub. The package is not
  in the `InstalledRegistry`.
- **Own state.** Setup values come from the draft; secrets from `PreviewSecretBuffer`
  (vault namespace `core.builder-preview:<userEmail>:<draftId>`, dropped with the draft or on
  "clear all"), never from the plugin's production vault scope; `ctx.memory` is a `Map`-backed
  store per activation (`previewMemoryStore.ts`).
- **Same gates as installed.** `ctx.http` exists only when the manifest declares
  `permissions.network.outbound` or `web_scanner`, with the same accessor the kernel uses.
  `ctx.services` reads through to the live `ServiceRegistry` behind `createPreviewServiceGate`
  (`previewServices.ts`): only capabilities the draft's manifest declares, the declared major
  only, never a pool-shaped capability, never a raw model client; an unreadable manifest
  declares nothing.
- **One draft agent per draft.** `previewDraftAgents.ts`: an `agents` row with status `draft`
  and slug prefix `builder-preview-` (reserved on agent create), no grant row, removed when the
  preview closes for good and swept at boot.
- **Warm cache.** `PreviewCache` keeps up to 3 active previews per user (LRU); extracts live
  under `data/builder/.previews/` and are wiped at boot. Extraction limits: 5,000 entries,
  50 MB total, 10 MB per file.
- **Two entry points.** `runTurn` (the draft agent's tool loop, streamed) and `runDirectTool`
  (one captured tool, no model). `RuntimeSmokeService` reuses the same activation with stub
  values (`'smoke-test'`).

### Consequences

- 🟢 **Good:** The preview exercises the real `activate()`, the real tool handlers and the real
  network gate; nothing of it is visible to any agent or channel.
- 🟢 **Good:** Integration-backed drafts can be tested before install.
- 🔴 **Bad:** Draft code runs inside the kernel process with the kernel's privileges. The
  context is a contract for well-behaved code, not a boundary against hostile code. Acceptable
  only because the Builder is an admin tool and the code is the operator's own draft.
- 🔴 **Bad:** The process-wide egress guard (`pluginEgressGuard.ts`) attributes a request to a
  plugin by installed-package directory (`pluginEgressSource.ts`, `origin === 'installed'`). A
  preview extract is not such a directory, so a draft's use of the global `fetch` or
  `node:http` is attributed to the kernel and not refused; only `ctx.http` is gated in a
  preview.
- 🔴 **Bad:** The preview context is a second implementation of `PluginContext`. Every new
  accessor needs a preview counterpart, or drafts fail in preview only (`ctx.memory`, `ctx.jobs`
  and `ctx.http` were each added after such a failure: #207, #328, #275).
- ⚪ **Neutral:** Test credentials survive a restart in the vault; the UI labels them
  test-only. Preview turns carry no memory between turns beyond the stored transcript.

## Pros and Cons of the Options

### A — In-process activation with a preview context

- 🟢 Real code path, fast, no extra infrastructure.
- 🔴 No isolation from the kernel; duplicated context.

### B — Real install flagged as preview

- 🟢 One context implementation.
- 🔴 Tools, routes and jobs would exist instance-wide; a half-finished draft would be grantable.

### C — Separate process or container

- 🟢 Isolation.
- 🔴 The whole plugin context would have to cross a process boundary; no container runtime is
  guaranteed where the middleware runs.

## More Information

- Related: [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md);
  [ADR-0057](0057-builder-builds-as-host-child-process-with-shared-build-template.md),
  [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md).
- Paths: `middleware/src/plugins/builder/{previewRuntime,previewCache,previewChatService,previewDraftAgents,previewServices,previewSecretBuffer,previewMemoryStore,runtimeSmoke}.ts`,
  `middleware/src/routes/builderPreview.ts`, `middleware/src/platform/operatorJobRoutes.ts`
  (`PLUGIN_BUILDER_PREVIEW`).
- Tests: `middleware/test/builder/{previewRuntime,previewCache,previewChatService,previewDraftAgents,previewSecretBuffer,previewCtxJobsRegisterRepro,builderPreviewRoutes}.test.ts`.
