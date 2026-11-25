# 0073 — Dispatch guards: no provider means off, a failing provider means refuse, a refusal is a tool result

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #731 (audience-floor egress guard, issue #575), #736
  (command-policy seam, issue #580), #681 and #750 (inbound screening, issues #579 and #749)
- **Supersedes:** —

## Context and Problem Statement

Several policy checks hang on the agent runtime's tool dispatch and turn entry: the audience
floor (what this room may do), the command policy (which shell-shaped commands may run), and the
provenance-labelled inbound screening of a turn's sources. Each one arrived as a new seam in a
runtime that existing installs already used. A guard that defaults to "deny" when nobody
configured it disables every tool in every turn; a guard that throws turns a policy decision
into an outage. This record is retroactive.

Which default, which failure behaviour and which refusal form does a guard seam in the runtime
have?

## Decision Drivers

- Introducing a guard must not change any existing turn.
- A deployment that opted in must not be waved through when its policy cannot be evaluated.
- The model must be able to explain a refusal or take another route.
- Observe-before-enforce must be one concept, not one per backend.

## Considered Options

- **A — Honest-inert seams: absent provider = not enforced; present provider that fails or
  cannot decide = refuse; refusal as an `Error:` tool result; screening fails open with evidence.**
- **B — Deny by default** until a policy is configured.
- **C — Exceptions for policy refusals.**

## Decision Outcome

Chosen option: **A**.

- **Absent provider means off, not closed.** `guardToolEgress` (`audienceFloorGuard.ts`) and the
  command-policy guard (`commandPolicyGuard.ts`) are no-ops until a provider is installed on the
  turn context, the same shape as `turnContext.privacyHandle`.
- **Present provider, undecidable result means refuse.** A `closed` audience floor refuses. A
  command-policy provider that throws is a refusal. A normalization that truncated is refused,
  not cleared. `require_approval` has no approval gate yet and therefore refuses with a reason
  that says approval is required.
- **Per dispatch, not per turn, for outbound effects.** The audience floor is re-evaluated on
  every dispatch, because someone can join the conversation between the model's decision and the
  call; rendered context cannot be un-sent, so the context guard snapshots instead.
- **A refusal is a tool result.** It reads back as a plain `Error: …` string in the tool's result
  slot, like the dispatch deadline; nothing throws into the turn.
- **Inbound screening** (`securityScreener.ts`). Two interchangeable backends behind one
  interface (an LLM judge by default, an HTTP screening proxy when the operator sets a URL).
  `shadow` versus `enforce` is the posture's mode, resolved once per turn by the orchestrator,
  never a backend property. A screener that throws, rejects or times out yields `unscreenable`:
  the turn runs, the `UNSCREENED_MARKER` is folded into the wire prompt and the miss is audited
  (fail open with evidence). In `enforce` a quarantine short-circuits the turn.
- **Seams may precede their consumer.** The command-policy seam shipped before any shell-execute
  tool exists; today no tool input carries a command field, so the guard finds nothing. Its
  active path is exercised by tests with a stub provider.

### Consequences

- 🟢 **Good:** Each guard could ship without breaking an install that had not asked for it.
- 🟢 **Good:** A refusal is explainable by the agent instead of ending the turn.
- 🔴 **Bad:** "Off unless a provider is installed" makes the protection depend on the wiring. For
  the audience floor the kernel now installs a provider by default (#2048, spec 2042 G15), so a
  fresh configuration enforces it; the command policy has no provider in any shipped deployment.
- 🔴 **Bad:** Screening fails open: a broken screener lets the turn run, marked and audited but
  not stopped.
- 🔴 **Bad:** `require_approval` is a refusal until the cross-channel approval surface exists
  (ADR-0005 covers the confirmation model, not this gate).
- ⚪ **Neutral:** The command guard inspects only top-level string values under conventional keys
  (`command`, `cmd`, `script`, `shell`, `shellCommand`).

## Pros and Cons of the Options

### A — Honest-inert, refuse on failure, tool-result refusals

- 🟢 Safe rollout; fail-safe once opted in.
- 🔴 Protection depends on a provider being installed.

### B — Deny by default

- 🟢 Safe without configuration.
- 🔴 Would silently disable every tool in every existing deployment.

### C — Exceptions

- 🟢 Simple control flow.
- 🔴 A policy decision becomes a failed turn and the model cannot explain it.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/audienceFloorGuard.ts`,
  `audienceFloorProvider.ts`, `commandPolicyGuard.ts`, `securityScreener.ts`,
  `securityScreenMetrics.ts`, `turnContext.ts`.
- Tests: `middleware/test/audienceFloorGuard.test.ts`, `audienceFloorDefaultOn.test.ts`,
  `commandPolicyGuard580.test.ts`, `securityPosture579.test.ts`, `securityScreenMetrics749.test.ts`.
- Related: ADR-0005, ADR-0016, ADR-0018 (audience floor required for consultation), ADR-0019,
  [ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md).
- Border: security (postures, audience floor, command policy primitives live in channel-sdk).
