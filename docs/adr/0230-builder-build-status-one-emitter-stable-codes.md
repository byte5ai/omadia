# 0230 — Builder build status has one emitter, stable codes, and a missing test credential is not a failed build

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Builder maintainers (Welle 5, W20), decision by recommendation
- **Supersedes:** —

## Context and Problem Statement

The Builder workspace, AutoFix ([ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md))
and the Publish gate all read the `build_status` events of a draft's spec bus and treat the
latest event as the truth. Two copies of "build, emit, activate" emitted those events: the
auto-rebuild scheduler and the preview routes. They drifted. Failed events carried no build
number, so AutoFix's per-build dedup fired once per process (#1731); the scheduler re-emitted
a second `failed` with its log line, the user's e-mail and the draft id, over the error list
(#1733); `building` was emitted before a cache hit that then never said `ok` (#1807); and a
test credential the draft reads at activation turned into a failed build with "Fix with
Builder" (#1809). What is the one contract for build status?

## Decision Drivers

- The latest event must be true, because every consumer treats it so.
- A client-visible reason must never carry a log line, an e-mail, a draft id or a server path.
- AutoFix must be able to dedup per build and must not burn turns on things code cannot fix.
- The Publish gate must name what is actually missing.

## Considered Options

- **A — One shared emitter (`previewWarmBuild.ts`) with fixed rules**
- **B — Keep both copies and patch each defect in place**
- **C — Add a new phase (`needs_credentials`) to `build_status`**

## Decision Outcome

Chosen option: **A**.

- **One emitter.** `warmPreview()` in `middleware/src/plugins/builder/previewWarmBuild.ts` is
  the only code that builds, activates and emits `build_status` for a preview. The scheduler
  and the preview routes call it; an error it throws is already reported and is not emitted
  again.
- **`building` only on a build.** It is emitted when a build starts (cache miss), never
  before a cache hit.
- **Every `failed` once, with `buildN` when one exists**, and `reason` a stable code:
  a `BuildFailureReason` (`tsc`, `timeout`, …), a `BuildPipelineError` code, `preview_failed`,
  or `activate_failed:<ActivationErrorCode>`. The activation message stays server-side: logged,
  and recorded on `BuildPipeline` for the builder agent's `get_build_status`.
- **A missing test credential is not a failed build.** A setup value read at activation
  without a test value (`PreviewSetupValueMissingError`, named like the plugin-api
  `MissingSecretError` / `MissingConfigError`) keeps the build `ok` and adds
  `missingSetupKey`. The status route returns it after a reload; the Publish gate counts it as
  a missing credential. Chat and refresh answer `builder.preview_secret_missing` (HTTP 409 on
  the JSON routes).
- **A stale result is dropped.** An activation result for a build a newer one superseded is
  neither recorded nor emitted.
- **The cold cache is not `idle`.** `GET /drafts/:id/preview/status` reports a green last build
  as `{ phase: 'ok', warm: false }`; saving or clearing test credentials schedules a rebuild.
- **AutoFix** (refines ADR-0056's "one synthetic turn per build"): only a real `buildN`
  dedups; a failure without one is bounded by `MAX_IDENTICAL_ATTEMPTS` alone. A key is
  released on every return that did not fire, so a failure while AutoFix is off does not
  block a later trigger.

### Consequences

- 🟢 **Good:** the two paths cannot drift again; a defect is fixed once.
- 🟢 **Good:** the footer, the error list, "Fix with Builder" and AutoFix see the same event.
- 🟢 **Good:** Publish says "missing test credential" instead of "Last build must succeed".
- 🔴 **Bad:** the operator sees `activate_failed:unknown` without the message; the detail is in
  the server log and in `get_build_status` for the builder agent.
- 🔴 **Bad:** the last build status is still in memory (ADR-0056): after a restart the status
  route answers `idle` until the next build.
- ⚪ **Neutral:** `ok` no longer means "preview is warm"; `warm: false` says so where it matters.

## Pros and Cons of the Options

### A — One shared emitter

- 🟢 One place for the rules; tests pin them once.
- 🔴 A larger diff than patching in place.

### B — Patch both copies

- 🟢 Smallest diff.
- 🔴 Exactly how the drift happened.

### C — New `needs_credentials` phase

- 🟢 Explicit on the wire.
- 🔴 Every consumer of the phase union (workspace, chat pane, AutoFix, publish gate) changes,
  and the build did succeed: `ok` plus a field says that truthfully.

## More Information

- Issues #1730, #1731, #1733, #1792, #1806, #1807, #1809.
- [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md) (gates, AutoFix),
  [ADR-0059](0059-builder-preview-in-process-with-captured-tools.md) (preview runtime, secrets).
