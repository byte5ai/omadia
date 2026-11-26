# 0232 — The runtime smoke passes only when a handler ran, on its own stub instance, and never calls a tool declared as writing

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Builder maintainers (Welle 5, W20); owner question on #1727 decided by
  recommendation, reversible
- **Supersedes:** the runtime-smoke bullet of [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md)
  ("a Zod rejection of the synthetic input … count[s] as controlled exits"). The rest of
  ADR-0056 stands.

## Context and Problem Statement

ADR-0056 defines the runtime smoke after a green build as "no crash and no timeout", with a
Zod rejection of the synthetic input and an upstream 401 on stub credentials as controlled
exits. In practice the smoke sent `null` to every tool whose schema it could not read, the
tool's own Zod schema rejected it, and every build reported a green smoke although no handler
ever ran (#1727). At the same time the smoke ran on the warm preview handle, which holds the
operator's test credentials, so once a handler did run, every tool — writes included — hit the
real system after every build (#1778), contrary to ADR-0059 ("the smoke reuses the same
activation with stub values"). What does a green smoke mean, and on which instance may it run?

## Decision Drivers

- A green smoke must mean "the code path ran", or the Builder agent and AutoFix act on a lie.
- A build must not cause side effects in external systems.
- Integration plugins must still be smokable without real credentials.

## Considered Options

- **A — Handler must run; own stub instance; writing tools skipped**
- **B — Keep `validation_failed` green; only skip writing tools on the warm handle**
- **C — Smoke only tools that declare `side_effects: 'read' | 'none'`**

## Decision Outcome

Chosen option: **A**.

- **A pass needs a handler that ran.** Per tool: `ok` (resolved), `auth_rejected` (the handler
  ran and the upstream refused the stub credentials: HTTP 401/403 on the error, its `response`
  or `cause`, else an HTTP-shaped message such as `status 401`, `401 Unauthorized`,
  `403 Forbidden` or `invalid api key`) and `skipped` pass; `validation_failed` (the tool's input schema
  rejected the synthetic input), `threw` and `timeout` fail. The synthetic input is built from
  the schema the plugin registered (`ctx.tools.register`), not from `spec.tools[].input`.
- **Own stub instance.** `RuntimeSmokeOrchestrator` activates the fresh build's ZIP a second
  time through `PreviewRuntime.activate` with every setup value set to `'smoke-test'` and
  `ctx.smokeMode === true`, in its own directory (`<draft>-<rev>-smoke`), and closes it after the
  run. The warm preview handle and its test credentials are never used by the smoke.
- **Writing tools are not called.** A tool whose spec entry says `side_effects: 'write'` gets
  `skipped`. If every tool is skipped, the result is `ok` with reason `writes_skipped`, so the UI
  says that nothing was called instead of a plain green.
- A cache hit builds nothing and smokes nothing; dedup per `(draft, rev)` stays.

### Consequences

- 🟢 **Good:** a green smoke now means at least one handler ran without crashing, or the plugin
  only writes and says so.
- 🟢 **Good:** no build writes to an external system through the operator's credentials.
- 🔴 **Bad:** tools that previously "passed" with `validation_failed` now fail and, with
  AutoFix on, trigger a fix turn — intended, but visible as more red after the rollout.
- 🔴 **Bad:** `ctx.services` in the preview reads through to the live kernel services
  (ADR-0059). A writing tool that does not declare `side_effects: 'write'` can still write
  through a kernel service during the smoke; the spec declaration is the guard.
- 🔴 **Bad:** the auth-rejection check falls back to an HTTP-shaped message when an SDK
  carries no status; a tool that throws such text for another reason passes.
- ⚪ **Neutral:** each fresh build is extracted and activated twice (preview + smoke).

## Pros and Cons of the Options

### A — Handler must run; own stub instance; writing tools skipped

- 🟢 Matches what the smoke claims and what ADR-0059 already says about stub values.
- 🔴 A second activation per build.

### B — Keep `validation_failed` green, skip writes on the warm handle

- 🟢 Smallest change.
- 🔴 Green still says nothing, and read tools still run with the operator's credentials.

### C — Only declared read tools

- 🟢 Safest.
- 🔴 The Builder rarely sets `side_effects`; almost nothing would be smoked.

## More Information

- Issues #1727 (decision by recommendation), #1778.
- `middleware/src/plugins/builder/runtimeSmoke.ts`, `runtimeSmokeOrchestrator.ts`.
- [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md),
  [ADR-0059](0059-builder-preview-in-process-with-captured-tools.md),
  [ADR-0230](0230-builder-build-status-one-emitter-stable-codes.md).
