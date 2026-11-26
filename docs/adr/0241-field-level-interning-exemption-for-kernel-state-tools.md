# 0241 — Field-level interning exemption for kernel tools that mix state and user text

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W22-23; owner question of #1768 decided after
  recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

The Privacy Shield interns every tool result except the agent's own scaffolding
(`INTERN_EXEMPT_TOOLS`, ADR [0094](0094-privacy-shield-data-plane-boundary.md)).
`manage_routine` returns the user's own routines: ids, names, schedules, status and
timestamps, which the agent must act on, mixed with text the user typed (the routine's
prompt) and the error a run recorded. Interned, the model could not find a routine by name
or confirm a pause, and guessed ids from creation times (#1768). Exempt as a whole, the
user's free text would reach the model as trusted, unmasked state. How does such a result
reach the model?

## Decision Drivers

- The agent must read the operational state it manages (names, cron, status).
- Free text a user typed stays behind the shield, like any other content.
- The exemption must stay auditable and narrow (one list, kernel-written result shapes).
- ADR [0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md): nothing handed over in
  clear may be served to a third party on the public MCP endpoint.

## Considered Options

- **A — field-level exemption: a projected clear copy without the free-text keys**
- **B — exempt the whole tool, and have the tool drop `prompt` from its result**
- **C — keep interning and teach the model to work with masked names**

## Decision Outcome

Chosen option: **A**.

- `INTERN_FIELD_EXEMPT_TOOLS` (`harness-orchestrator/src/privacyInternPolicy.ts`) maps a
  kernel tool to the keys its model copy withholds. `fieldExemptModelCopy` parses the JSON
  result and removes those keys at every depth; the rest goes to the model in clear, like
  an exempt tool's result.
- `manage_routine` is the only entry: `prompt`, `lastRunError` and the smart-card sidecar
  `_pendingRoutineList` are withheld. The smart card still reads the raw result.
- All three seams apply it after the whole-tool exemption and before bypass and interning:
  `Orchestrator.dispatchTool`, `LocalSubAgent`, `ToolDispatchService`. An `Error:` result
  and a result that is not a JSON object or array are not projected; they take the normal
  path (redaction, interning — fail closed).
- `isPubliclyServableTool` refuses field-exempt tools like exempt ones.

### Consequences

- 🟢 **Good:** "pause the routine report-alt" works; the model confirms the new status.
- 🟢 **Good:** the user's prompt text never reaches the model through this tool.
- 🔴 **Bad:** the routine **name** is user-chosen text and reaches the model in clear. It is
  a label the user gave to address the routine; accepted as the price of addressing it.
- 🔴 **Bad:** the model cannot quote a routine's prompt back ("what does report-alt do?").
- ⚪ **Neutral:** a second tool needs its own reviewed entry; the list is not configurable.

## Pros and Cons of the Options

### A — field-level exemption

- 🟢 State in clear, free text withheld, one auditable list.
- 🔴 A second mechanism next to the whole-tool list.

### B — whole-tool exemption, tool drops `prompt`

- 🟢 No new mechanism.
- 🔴 The privacy property depends on the tool remembering to drop fields; the shield no
  longer sees the result at all, and `lastRunError` (which can quote data) would pass.

### C — keep interning

- 🟢 Nothing changes in the shield.
- 🔴 The agent stays blind to its own routines and deletes by guesswork.

## More Information

- Issue #1768; ADRs [0094](0094-privacy-shield-data-plane-boundary.md),
  [0097](0097-unprotected-provenance-for-stored-content.md),
  [0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md).
