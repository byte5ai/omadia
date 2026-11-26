# 0074 — The fast lane: one triage, one deterministic read query, any miss falls back to the agent

## Status

Accepted — amended by [ADR-0221](0221-a-fast-lane-miss-hands-its-executed-call-to-the-agent.md) (a miss after the query ran hands the executed call to the agent)

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; fast lane under the agent per spec 2042 (#1876), decision-model
  gate #1668, turn gate #1670
- **Supersedes:** —

## Context and Problem Statement

A simple data question ("birthdays in January") does not need the agent's full model loop, which
costs many seconds and sends rows through a model. ADR-0012 keeps the former fast path as the
agent's **fast lane** and ADR-0021 demands deterministic paths and side-channel data. Neither
records how the lane decides, what it may run, or why its answers are not verified. This record
is retroactive.

When may a turn be answered without the agent's model loop, and what keeps that safe?

## Decision Drivers

- No model sees the rows; figures are computed, not generated.
- The lane runs inside the addressed agent's envelope: its tools, boundaries, disclosure.
- A wrong shortcut is worse than a slow answer: any doubt goes to the agent.
- The triage itself must be cheap, and its prompt masked like any prompt.

## Considered Options

- **A — A `ChatAgent` decorator per agent that asks `fastPath@1` for one triage; on a confident
  hit the plugin runs one read query and renders it; otherwise the agent runs unchanged.**
- **B — Leave data questions to the agent loop** with a cheaper model.
- **C — Hand-written deterministic intents per tool.**

## Decision Outcome

Chosen option: **A** (`fastPathAgent.ts` in `@omadia/orchestrator`, `@omadia/fast-path`).

- **Scope.** Only human text turns are triaged. Slash commands, attachments, empty text,
  structured actions and system or headless turns (schedules, Conductor steps, verifier retries)
  never are. The canvas runs the same service through its own composer.
- **What may run.** Only tools the wrapped agent itself offers its model now, intersected with the
  configured fast-path tools; unknown tool set means no fast lane (fail closed). Read tools only;
  write tools never. The agent's boundary check runs on every plan, new or cached, before the
  fetch (`checkPlan`), and on the planner's summary template and column labels.
- **One triage** (`triageTurn.ts`). Order: (0) the answer cache, with zero model calls; (1) the
  user-derived part masked once through the turn's privacy run, fixed text in system prompts;
  (2) router and planner start together on a fast model and the plan is used only when the router
  decides deterministic with enough confidence for the same tool.
- **Decision model first** (`turnGate.ts`, optional `decisionModel@1`). All gate questions go out
  in one request. Yes/no answers are probabilities with two bars (`DATA_YES` 0.6, `DATA_NO` 0.4);
  a value between the bars decides nothing and the LLM router takes the turn. A slot value needs
  0.85 (`SLOT_MIN_CONFIDENCE`). A learned plan may then run without the planner. Any failure
  falls back to the LLM path.
- **Hit.** The service runs the one query and renders a templated summary plus a table; the
  wrapper streams it as `text_delta` + `done`, records the turn through the session logger, and
  the inner agent is never called. Under a Privacy Shield the recorded turn gets an empty masked
  view, so no capture job sends the rows to a model.
- **Miss.** Service absent, channel filtered, privacy refusal, invalid plan, tool error: the inner
  agent runs byte-for-byte. An agent-routed turn passes the triage's simple/complex verdict on as
  `routeHint`, so the model router does not classify again.
- **Not verified, on purpose.** A hit carries no model claim: rows are system data from the tool,
  figures are computed, and the triage model chose only a query and a sentence template from the
  masked request.
- **Learned plans and the cache store no row data:** literal-stripped tool inputs and stripped
  example questions in one plugin-wide memory file; the cache stores nothing without a Privacy
  Shield.

### Consequences

- 🟢 **Good:** Simple lookups answer in seconds and no model sees their rows.
- 🟢 **Good:** The lane cannot reach a tool or cross a boundary the agent could not.
- 🔴 **Bad:** On every channel but the canvas each message costs one quick model check before the
  agent; with the speculative planner an agent-routed turn also pays one planner call (tokens,
  not latency).
- 🔴 **Bad:** A confidently wrong route yields a correct table for the wrong question, unverified.
- 🔴 **Bad:** Thresholds are constants in code, tuned on live findings, not operator settings.
- ⚪ **Neutral:** `fast_path_channels`, `fast_path_tools`, `fast_path_generic_tools` and the
  decision-model switches are the operator's controls.

## Pros and Cons of the Options

### A — One triage, deterministic execution

- 🟢 Fast, private, inside the envelope, self-falling-back.
- 🔴 A second decision path to keep consistent with the agent.

### B — Agent loop only

- 🟢 One path.
- 🔴 Slow, costly, rows pass through a model.

### C — Hand-written intents

- 🟢 Fully deterministic.
- 🔴 Does not scale to plugin and MCP read tools.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/fastPathAgent.ts`,
  `middleware/packages/harness-plugin-fast-path/src/{triageTurn,turnGate,decisionRouter,answerCache,learnedPlanStore,service}.ts`,
  `manifest.yaml`.
- Tests: `middleware/test/fastPathChatTriage.test.ts`, `fastPathTurnGate.test.ts`,
  `fastPathDecisionModel.test.ts`, `fastPathAnswerCache.test.ts`, `dataPlanBoundaries.test.ts`.
- Related: ADR-0012 (fast lane), ADR-0016, ADR-0021, spec 2042 §5.13,
  [ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md).
- Border: LLM providers (the `decisionModel@1` provider), privacy (stored-text masking).
