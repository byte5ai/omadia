# 0177 — Files and diagrams a tool produces are delivered only with the turn that produced them

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W00 security fast track; issue #1961)
- **Supersedes:** —

## Context and Problem Statement

A plugin creates one tool instance at activation, and every turn of every agent shares it. Office
(`create_xlsx`, `create_docx`) kept finished files in one instance-wide list and Diagrams kept one
`lastRender`; at the end of a turn the kernel drained every registered attachment sink. When two
turns ran at once, the turn that finished first received the other turn's files and diagrams —
including another user's document with a valid signed link — and the turn that asked for them got
nothing. Two diagrams in one turn gave one image. Where does a tool's pending output live, and who
may collect it?

## Decision Drivers

- An output must never reach another conversation or user
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0019](0019-discretion-as-information-flow-control.md)).
- The plugin-api sink contract (`NativeToolAttachmentSink = () => …`) is implemented by plugins
  outside this repo; changing its signature is a breaking change.
- The pending MCP input state was already keyed on the turn id for the same reason.

## Considered Options

- **A — Plugins file outputs per turn id and drain only the finishing turn's.**
- **B — The kernel passes the turn id into the sink.** Signature change in plugin-api.
- **C — A tool instance per turn.** Activation creates instances once; a large lifecycle change.

## Decision Outcome

Chosen option: **A**.

- **Per-turn buffer.** `PerTurnBuffer` (`@omadia/diagrams`) files each output under the id of the
  turn whose tool call produced it and returns only that turn's on drain. It is bounded
  (`MAX_PENDING_TURNS`, oldest turn dropped) so turns that never drain do not grow it.
- **Turn id source.** The kernel's `turnContext` service (`currentTurnId()`). Office reads it
  directly (`@omadia/orchestrator`), Diagrams through `ctx.services` with
  `optional_requires: ["turnContext@1"]`.
- **Contract, unchanged signature.** The kernel calls every sink inside the finishing turn's
  context; a sink returns only what that turn produced. Documented on
  `NativeToolAttachmentSink`; a sink that keeps an instance-wide buffer violates it.
- **Several outputs per turn** are all delivered (two diagrams give two images).

### Consequences

- 🟢 **Good:** A turn that made no tool call receives no attachments.
- 🟢 **Good:** No plugin-api version change; third-party sinks keep compiling.
- 🔴 **Bad:** The contract is a documented rule, not enforced by types; a third-party sink can
  still keep one buffer.
- 🔴 **Bad:** Calls without a turn id (routine runners with a placeholder id) share one bucket.
- 🔴 **Bad:** CLI-backed agents (`cliChatAgent.ts`) never drained attachment sinks; their files
  were delivered only by accident, to whichever in-process turn finished next. They now stay in
  their own turn's bucket until evicted. Delivering them on the CLI path is a follow-up.
- ⚪ **Neutral:** The replay ledger for verifier re-entries is unchanged.

## Pros and Cons of the Options

### A — Per-turn filing in the plugin

- 🟢 Fixes both built-ins without a contract break.
- 🔴 Every sink author has to follow the rule.

### B — Turn id as a sink argument

- 🟢 Makes the rule visible in the type.
- 🔴 Changes the plugin-api surface; plugins would still have to file per turn at call time.

### C — Instance per turn

- 🟢 Isolation by construction.
- 🔴 Tools, routes and services are registered once at activation; out of scope.

## More Information

- Issue #1961, related #1769. Code: `middleware/packages/harness-diagrams/src/perTurnBuffer.ts`,
  `diagramTool.ts`, `plugin.ts`; `middleware/packages/harness-plugin-office/src/{officeTool,plugin}.ts`;
  `drainAttachments` in `middleware/packages/harness-orchestrator/src/orchestrator.ts`.
