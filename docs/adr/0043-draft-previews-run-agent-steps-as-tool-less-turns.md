# 0043 — Draft previews run agent steps as tool-less turns

## Status

Proposed

- **Date:** 2026-11-25
- **Deciders:** Owner (byte5), plan approved 2026-11-25; issue #2217
- **Supersedes:** — (refines the preview behaviour #2007 introduced)

## Context and Problem Statement

A Conductor draft preview (`ConductorRunExecutor.previewRun`,
`middleware/src/conductor/runExecutor.ts`) walks a workflow graph in memory
before it is activated. Until #2007 it ran agent steps as full turns, which let
a rehearsal call connectors, write memory and post into chats. #2007 replaced
each agent step with the placeholder `{ simulated: true, agentId }`. That
removed the side effects but also the step's answer: a transition guard on
`stepResult.text` or `stepResult.data.*` (the fenced-JSON verdict, #330 C3)
then routes differently in the preview than in the live run, and the preview
answers "would this workflow work?" for a workflow that does not exist.

How does a preview see the answer an agent would give, without the
rehearsal touching anything?

## Decision Drivers

- A guard on agent output routes in the preview the way it routes live.
- A preview has no side effects: no connector call, no memory write, no
  sub-agent, no chat message, no typing indicator, no transcript row.
- Every model call stays inside an agent-turn context (ADR 0017 already
  charges draft previews to the agent's envelope).
- One switch that every runtime honours: both orchestrator tool loops, the
  `claude-cli` runtime, the fast path, the verifier and facilitator wrappers.

## Considered Options

- **A — Real turn without tools** (`ChatTurnInput.toolsOff`)
- **B — Placeholder result** (status quo since #2007)
- **C — Real turn with mocked tools** (per-tool fakes or recorded results)

## Decision Outcome

Chosen option: **A**.

- **Contract.** `ChatTurnInput.toolsOff?: boolean` (`@omadia/channel-sdk`
  0.3.15, additive). A tool-less turn gets no tool definitions and a static
  per-turn directive saying so (`TOOLS_OFF_DIRECTIVE`,
  `packages/harness-orchestrator/src/toolsOffTurn.ts`). Everything else is
  the real turn: the agent's prompt, model, persona, privacy shield and
  verifier. It is set by trusted in-process callers only, never from channel
  input.
- **Orchestrator.** Both tool loops send `tools: []`, force no consult
  obligation, skip the file-build retry and the card-router pass, and fire
  no `onBeforeTurn` hook (the plan-runner's process reuse would otherwise
  write Plan nodes even under `planHint: 'direct'`). A tool call the
  model emits anyway is refused before dispatch (`ToolsOffViolationError`)
  and fails the turn.
- **claude-cli.** No loopback MCP server, an mcp-config without servers,
  nothing pre-approved. The permission gate (`buildCliToolGateArgv`) is
  unchanged, and the init check then expects zero omadia tools.
- **Fast path.** A tool-less turn is passed through untriaged.
- **Conductor.** `StepMeta.preview` marks a preview step. `RealStepEffects`
  then runs the turn with `toolsOff` and **without a session scope** (no
  transcript row, no graph turn, nothing a later live run recalls), shows no
  typing indicator and publishes no `say`. The step result carries
  `previewed: true` and, for a `say` step, `say: 'skipped_in_preview'`.
  A throwing agent step is the preview's failure reason again, not a 500.
  A preview runs at most `MAX_PREVIEW_AGENT_STEPS` (25) agent steps and then
  fails with `max_steps_exceeded`: a loop guarded on agent output, which
  ended instantly on placeholders, would otherwise bill up to the engine's
  1000-step budget inside one HTTP request.
- **Action steps stay stubbed.** A connector action has no side-effect-free
  mode, so this ADR does not change them.

### Consequences

- 🟢 **Good:** Guards on agent output route in the preview as they do live.
- 🟢 **Good:** One flag, enforced in every runtime, with a dispatch-time
  refusal behind the empty tool list.
- 🔴 **Bad:** Every preview with agent steps now costs model calls, charged
  to the agent (ADR 0017). Accepted by the owner; a "simulate agent steps"
  toggle in the preview UI is a follow-up.
- 🔴 **Bad:** An answer that needs tool data differs from the live one: the
  agent answers from the prompt and run context only. Guards on such
  answers can still route differently. A guard on `stepResult.said` never
  sees `said` in a preview.
- 🔴 **Bad:** The flag fails open: a `StepEffects` implementation that
  ignores `StepMeta.preview` would run a live turn. Only `RealStepEffects`
  and the stub exist today.
- ⚪ **Neutral:** The verifier still checks a preview answer and may read
  Odoo for claim evidence (read-only). Verifier verdict rows and privacy
  receipts are still written; they are audit records, not conversation.
- ⚪ **Neutral:** The stable system prompt still describes the agent's
  tools; only the per-turn directive says they are unavailable.

## Pros and Cons of the Options

### A — Real turn without tools

- 🟢 The agent's real reasoning, persona and output format reach the guards.
- 🟢 Side-effect-free by construction, not by convention.
- 🔴 Costs model calls; answers needing tool data diverge.

### B — Placeholder result

- 🟢 Free and instant.
- 🔴 Every guard on agent output is evaluated against a fake, so the preview
  can show a path the live run never takes.

### C — Real turn with mocked tools

- 🟢 Closest to the live answer.
- 🔴 A mock per tool and per plugin. Fakes drift from the real tools, and a
  missing mock silently falls through to the real one.

## More Information

- Issue #2217; #2007 (placeholder); #1698/#1699 (preview mirrors the real
  run's normalisation and failure reasons).
- [ADR-0017](0017-model-gateway-and-execution-contexts.md): draft previews run
  in the agent-turn context.
- Code: `middleware/src/conductor/realStepEffects.ts`,
  `middleware/src/conductor/runExecutor.ts` (`previewRun`),
  `middleware/packages/harness-orchestrator/src/toolsOffTurn.ts`,
  `cliChatAgent.ts`, `fastPathAgent.ts`.
