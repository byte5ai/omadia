# 0081 — One fallback hop before any output, for availability failures only; a per-provider breaker skips a failing provider

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #1033 model policy W1–W3, #1405 sub-agent fallback)
- **Supersedes:** —

## Context and Problem Statement

The process used to hold one provider: `llm_provider` was read once at activation, and a
per-agent model on another provider was rejected at write time. During a provider outage
every turn failed after the full retry budget (5 attempts with backoff, about 30 to 40
seconds). After a provider switch, sub-agents whose manifest still named a model of the
old provider failed every delegation with `model_not_found`. When may a turn continue on
another model or provider, and what stops every turn from paying for the same outage?
This record is retroactive. It borders the agent runtime domain.

## Decision Drivers

- A turn must not produce output twice or mix two models' partial answers.
- A failure that would repeat on the second model must not cost a second full request.
- One agent's mistyped model ref must not move every agent off a healthy provider.
- Policy on disk must be readable by an older or newer process during a rolling deploy.

## Considered Options

- **A — Per-agent policy with one optional fallback; one hop before output; breaker per provider**
- **B — Ordered chain of several fallbacks, also mid-stream**
- **C — No automatic fallback; the operator switches the provider**
- **D — A separately configured fallback model per sub-agent**

## Decision Outcome

Chosen option: **A**.

- **Policy.** `agents.model_policy` (migration `0059_agent_model_policy.sql`) holds
  `{ primary: 'auto' | ModelRef, fallback: 'none' | 'auto' | ModelRef }`; the default is
  `auto` / `none`. `parseModelPolicy` reads any shape it does not recognise as the
  default. `validateModelPolicy` is the write-time gate: the provider must be registered
  and have a credential, the model must be in the catalog, a named effort must be one the
  model declares, and fallback must differ from primary. Primary and fallback may be on
  different providers.
- **Providers are pooled by id** (`createLlmProviderPool`, `llm-provider/src/providerPool.ts`):
  built on first use, concurrent first calls share one resolution, entries are dropped
  when a key changes.
- **One hop, before output.** `streaming.ts` switches to the fallback at most once per
  turn and only while no text was forwarded. The fallback gets its own retry budget. The
  orchestrator builds the complete fallback request (model, effort, family-specific
  system prompt); the stream layer decides only when to switch. The buffered path
  (`completeWithFallback`) follows the same rule. A `fallback` event names the provider,
  model and reason, and the ledger row carries the provider that actually ran.
- **Availability failures only** (`fallbackReasonFor`): `auth`, `rate_limit` or
  `overloaded` after the retry budget is spent, `unreachable`, `model_not_found`. Content
  and tool errors never switch.
- **Same-provider fallback** takes only `model_not_found`; a broken key or endpoint would
  fail the second model as well (`accepts`).
- **Breaker per provider** (`createProviderHealth`, default cooldown 60 seconds): the
  first turn that switches for a provider-wide reason marks the provider failed; turns
  inside the cooldown start on their fallback; the first turn after it tries the primary
  again. `model_not_found` does not open the breaker. State is in memory, one entry per
  provider id.
- **Sub-agents fall back to the model the orchestrator runs this turn on**
  (`subAgentModelFallback.ts`). After a configuration failure (`model_not_found`,
  `auth`) the sub-agent skips its primary for 10 minutes (`PRIMARY_MODEL_COOLDOWN_MS`).
- **Where the sub-agent's fallback comes from.** The turn publishes where its own model calls
  run (`TurnContextValue.orchestratorExecution`, set after `resolveTurnExecution` and moved
  after the orchestrator's own fallback hop); `orchestratorFallbackFor` returns it to
  `LocalSubAgent`. There is none outside an orchestrator turn (builder, tests) and none when it
  equals the sub-agent's own provider and model. The stale id typically comes from a manifest
  or `SUB_AGENT_MODEL`. Transient failures (rate limit, overload, unreachable) hop only the run
  they hit; the provider-wide breaker stays the orchestrator's.
- **The write-time rule for helpers stays.** A helper's configured model must be one its
  agent's model policy allows (`helperModelVerdict`, `registry/internalHelpers.ts`); the
  fallback adds no model the agent's turn was not already running on.

### Consequences

- 🟢 **Good:** An outage costs one retry budget per provider per minute, not one per turn.
- 🟢 **Good:** A stale model id after a provider switch degrades to the orchestrator's
  model instead of failing every delegation.
- 🔴 **Bad:** A failure after the first forwarded text is not recovered; the turn fails.
- 🔴 **Bad:** The answer may come from a different model than the agent is configured for.
  It is visible in the `fallback` event and the ledger, and nowhere in the answer.
- 🔴 **Bad:** Breaker state is per process and lost on restart; several instances each
  learn about an outage on their own.
- 🔴 **Bad:** An agent with `fallback: none` has no second choice; a provider in cooldown
  still receives its turns and they fail.
- 🔴 **Bad:** A sub-agent meant to run on a cheap model silently runs on the agent's (usually
  more expensive) model; the signal is a server log line from `LocalSubAgent`.
- 🔴 **Bad:** The stale sub-agent configuration stays in place; after each cooldown the
  failing request is paid once more.
- ⚪ **Neutral:** Subscription-CLI sub-agents (`cliSubAgent.ts`) are a different runtime and
  do not take the sub-agent fallback.
- ⚪ **Neutral:** Thinking blocks produced by the primary travel with the messages; the
  receiving adapter strips or drops what the fallback model cannot read
  ([ADR-0085](0085-request-hints-degrade-in-the-adapter.md)).

## Pros and Cons of the Options

### A — One hop before output, breaker per provider

- 🟢 Bounded cost and a single author per answer.
- 🔴 No recovery mid-stream.

### B — Chain of fallbacks, also mid-stream

- 🟢 Highest availability.
- 🔴 Mixed answers, unbounded retries, and a turn's cost is hard to predict.

### C — No automatic fallback

- 🟢 The configured model is always the one that answers.
- 🔴 Every outage is a full outage until an operator acts.

### D — Per-sub-agent fallback model

- 🟢 Explicit.
- 🔴 One more id per sub-agent that goes stale the same way after a provider switch.

## More Information

- Related: [ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0082](0082-model-refs-classes-and-live-model-discovery.md), [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md).
- Paths: `middleware/packages/harness-orchestrator/src/{streaming,subAgentModelFallback}.ts`,
  `middleware/packages/harness-orchestrator/src/registry/modelPolicy.ts`,
  `middleware/packages/llm-provider/src/{providerPool,providerHealth}.ts`.
- Tests: `middleware/test/modelPolicy.test.ts`, `streamingFallback.test.ts`,
  `orchestratorProviderFallback.test.ts`, `subAgentModelFallback.test.ts`, `llmProviderPool.test.ts`.
