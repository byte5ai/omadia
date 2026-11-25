# 0085 — Callers send neutral hints; the adapter knows the model, and what a model does not take is left out, not raised

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #1033 effort, #1207 thinking replay, #1219 structured output and refusals)
- **Supersedes:** —

## Context and Problem Statement

Models differ in which request fields they accept, and a field a model does not know is
usually a hard 400. The differences cannot be derived from the model name: `claude-opus-5`
accepts a forced tool choice and `claude-opus-5-5` does not; `gpt-4o` rejects
`reasoning_effort` that GPT-5 takes. Callers such as the verifier, the security screener
and the card router ask for determinism, an effort level or a forced tool, and several of
them treat an exception as "pass". Where does knowledge about a model's parameters live,
and what happens to a hint the model cannot honour? This record is retroactive.

## Decision Drivers

- A policy or helper that names a hint must never break a turn on a provider or model
  without that knob.
- A caller must not need vendor or model knowledge.
- Fail-open helpers turn a 400 into a silently skipped check, which is worse than an
  unconstrained call.
- A new model that the code does not know must behave safely.

## Considered Options

- **A — Neutral optional hints; per-model knowledge in the adapter; unsupported hints are left out**
- **B — Strict contract: an unsupported hint raises, callers check capabilities first**
- **C — Callers build vendor-specific parameters themselves**

## Decision Outcome

Chosen option: **A**.

- **Hints are optional and normalized** on `LlmRequest`: `effort` (one vocabulary, mapped
  to Anthropic `output_config.effort` or OpenAI `reasoning_effort` / `reasoning.effort`),
  `thinking: 'off'`, `outputFormat`, `cacheHints`, `ToolSpec.strict`, `temperature`.
  An adapter for a provider or model without the concept ignores the hint and never
  errors (for `effort` and `outputFormat` with a one-time warning). A caller therefore still parses tolerantly: a hint narrows the output,
  it guarantees nothing across providers.
- **Per-model knowledge lives in the adapter as allowlists.** A model the list does not
  name gets the plain request. Examples on main: `supportsForcedToolChoice`,
  `supportsStrictTools`, `supportsThinkingReplay` in
  `llm-adapter-anthropic/src/anthropicProvider.ts`; `isOpenAiReasoningModel` in
  `llm-provider-api/src/reasoningModels.ts`. Other code refers to these functions and
  does not name models.
- **Forced tool choice degrades to `auto`** on models that reject it (keeping
  `disableParallel`). Every caller that forces a tool already treats "no tool call in the
  response" as a normal outcome.
- **The Anthropic adapter does not forward `temperature`.** API version 2026-10-21 rejects
  `temperature`, `top_p` and `top_k` on every model. Callers ask for `temperature: 0` on
  paths where an exception degrades to fail-open, so the field is dropped.
- **Which effort levels a model offers is declared per model** (`ModelInfo.effortLevels`).
  A policy naming an undeclared level is rejected at write time, not dropped at run time.
- **Provider reasoning is opaque.** A `ReasoningPart` is echoed back unchanged by the
  adapter that produced it and dropped by every other adapter. It is replayed only to
  models that take it; elsewhere it is stripped. Under the thinking-binding beta a block
  whose prefix no longer matches is dropped by the API and the drop is logged.
- **Server tools** (`ToolSpec.serverType`) are emitted only by the adapter that owns
  them; other adapters skip the tool and do not send a malformed function.
- **One escape hatch:** `LlmRequest.betas`, passed as a documented constant.
- **What is not silent:** an adapter whose vendor accepts only string tool results must
  raise on image parts, never drop them (`ToolResultPart`).

### Consequences

- 🟢 **Good:** The verifier, the card router and the screener keep working when the model
  behind a class changes.
- 🟢 **Good:** A new model defaults to the conservative request.
- 🔴 **Bad:** A caller cannot tell from the response whether its hint was applied. A
  "deterministic" call on Anthropic is not deterministic, and a forced tool may come back
  as prose.
- 🔴 **Bad:** The allowlists are hand-maintained and were measured against the live API on
  given dates (forced tool choice: 2026-09-23). A new model loses effort, strict tools or
  thinking replay until someone adds it.
- 🔴 **Bad:** `outputFormat` schemas are forwarded unchecked; a schema the vendor cannot
  compile is still a 400 and the caller owns it.
- ⚪ **Neutral:** The lists sit in two packages (the Anthropic adapter and the contract
  package for OpenAI reasoning models, which two adapters share).

## Pros and Cons of the Options

### A — Hints degrade in the adapter

- 🟢 No turn breaks on a knob; callers stay vendor-free.
- 🔴 Degradation is invisible to the caller.

### B — Strict contract

- 🟢 The caller always knows what was applied.
- 🔴 Every call site needs capability checks; a missed one is an outage on the next model.

### C — Vendor parameters at the call site

- 🟢 Full control.
- 🔴 Model knowledge in dozens of places; contradicts
  [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md).

## More Information

- Related: [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md),
  [ADR-0081](0081-model-policy-fallback-and-provider-circuit-breaker.md), [ADR-0077](0077-prompt-cache-layout-and-per-turn-tool-advertisement.md).
- Paths: `middleware/packages/llm-provider-api/src/{types,reasoningModels}.ts`,
  `middleware/packages/llm-adapter-anthropic/src/anthropicProvider.ts`,
  `middleware/packages/llm-adapter-openai/src/openaiProvider.ts`.
- Tests: `middleware/test/llmProviderAnthropicAdapter.test.ts`, `llmProviderOpenAiAdapter.test.ts`,
  `llmAdapterOpenAiResponses.test.ts`, `llmPluginForcedTool.test.ts`.
