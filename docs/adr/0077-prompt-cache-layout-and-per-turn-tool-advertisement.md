# 0077 — The prompt is laid out for the cache prefix; tools are advertised per turn, by name order, once per name

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #550 (deterministic tool order, W0-3), #1634 (stable prompt
  first, 1-hour cache), #1211 (finalize keeps the tool list), #1416 (per-turn availability,
  issues #1346/#1086), #474 (plugin readiness gate)
- **Supersedes:** —

## Context and Problem Statement

Each model request of a turn carries the tool list, the system prompt and the messages. Provider
prompt caching matches a byte-exact prefix in that order (tools → system → messages). The stable
system prompt is around 20k tokens. Three things silently broke the prefix or wasted rounds: the
prior-context block came first, so every turn with history re-wrote the stable prompt; tool
segments were iterated in `Map` insertion order, which differs across machines and deploys; and
tools that could only fail on a given turn (a discussion tool outside a Teams chat) were offered
anyway. A duplicate tool name made the provider reject the whole request. This record is
retroactive.

What is the rule for what a request contains and in which order?

## Decision Drivers

- The serialized tool block must be a function of the tool set, not of registration timing.
- Anything that changes per turn must come after everything that does not.
- The model should not be offered a call that can only fail.
- What is advertised must be exactly what dispatch will run.

## Considered Options

- **A — Stable-first layout with a 1-hour cache, name-sorted tools, per-turn advertisement
  predicates, one spec per name.**
- **B — Keep registration order and the default cache lifetime; accept misses.**
- **C — Gate at dispatch only** and let the model learn from the error.
- **D — One system string cached as a whole** (`cacheHints.system`).

## Decision Outcome

Chosen option: **A**.

- **Layout.** The stable prompt precedes every per-turn block (prior context, per-turn hints).
  All cache breakpoints carry `{ type: 'ephemeral', ttl: '1h' }` (`ORCHESTRATOR_CACHE_CONTROL`),
  so the prefix survives the gaps between a user's turns. Guardrail rules from `responseGuard@1`
  are prepended as their own cache element.
- **Breakpoint contract.** `LlmRequest.system` is a string or a list of `SystemBlock`s, each
  with an optional `cache` flag; blocks are authoritative over `cacheHints.system`.
  `cacheHints.tools` puts the breakpoint on the last tool. The orchestrator's blocks
  (`buildSystemBlocks`): the stable domain prompt (cached), the prior-context block when
  present (cached, so the turn's loop iterations read it), the per-turn date header (not
  cached), a per-turn hint such as a verifier correction (not cached; it is meant to
  invalidate the cache for the retry).
- **One TTL per request** (`CacheHints.ttl`). Anthropic requires longer-lived entries before
  shorter ones, so a request never mixes lifetimes. The code comment records the measurement
  behind the hour: with the 5-minute default nearly every turn's first call re-wrote the whole
  tools + stable-prompt prefix.
- **Adapters without the capability ignore the hints.** The OpenAI adapters
  (`openaiProvider.ts`, `responsesProvider.ts`) report `promptCaching: false`; the Anthropic
  adapter reports `true`.
- **Tool order.** Dynamic tool segments are sorted by name with a locale-pinned comparison
  (`compareToolNames`, `'en'`), and the last spec carries the cache breakpoint. Ordering is
  advertisement only: which handler a name resolves to is decided by `Map` insertion in
  `ToolDispatchService`, never by array position. MCP `tools/list` results are normalized the
  same way before they are persisted.
- **One spec per name.** A kernel/native collision is advertised once, and the survivor is the
  spec whose handler dispatch runs (the native registry wins).
- **Per-turn availability** (`ToolRegistrationOptions.isAvailable`, plugin-api). The predicate is
  honoured at every advertisement site: the API-path tool list, the system-prompt tool docs, and
  the list the loopback / public MCP server advertise (`isOfferedThisTurn`). It gates
  advertisement only; dispatch is not gated, so a handler still answers a call with a truthful
  `Error:`. It must be cheap, synchronous and constant for the turn. A throw hides the tool and
  is logged once per predicate. Outside a turn (public MCP `tools/list`) such tools are hidden.
- **Readiness and grants gate both sides.** A plugin whose tools are not ready (#474) or not
  granted is excluded from the list and refused at dispatch.
- **Finalize keeps the prefix** where the provider supports `tool_choice: none`
  ([ADR-0079](0079-tool-loop-bounds-loop-guard-finalize-and-timeout-hierarchy.md)).

### Consequences

- 🟢 **Good:** Cache hits no longer depend on plugin load order or on which machine serves the turn.
- 🟢 **Good:** Fewer wasted model rounds on channel-bound tools.
- 🔴 **Bad:** A 1-hour cache write costs more than the default lifetime; it pays off only when a
  user's turns follow within the hour.
- 🔴 **Bad:** Per-turn content (a predicate that flips, a hint placed early) breaks the prefix
  with no error; the only signal is the cache-read token counter.
- 🔴 **Bad:** `isAvailable` is advisory; a plugin author must still handle the call.
- ⚪ **Neutral:** A new prompt block must be classified as stable or per-turn before it is placed.
- 🔴 **Bad:** A 1-hour write bills at 2× the input rate instead of 1.25× (stated at
  `CacheHints.ttl`), but the ledger prices every cache write at `CACHE_WRITE_MULTIPLIER = 1.25`
  (`harness-usage-telemetry/src/pricing.ts`). The orchestrator's writes are recorded below what
  the vendor bills, and the reported cache saving is too high by the difference.
- ⚪ **Neutral:** The comment at the tool breakpoint in `orchestrator.ts` still speaks of a
  5-minute TTL although it sets `ORCHESTRATOR_CACHE_CONTROL` (comment drift).

## Pros and Cons of the Options

### A — Stable-first, sorted, per-turn predicates

- 🟢 Deterministic bytes; fewer failed rounds.
- 🔴 Ordering discipline for every future prompt element.

### B — Registration order

- 🟢 No work.
- 🔴 Silent cache loss for the tool block and everything after it.

### C — Dispatch-only gating

- 🟢 One enforcement point.
- 🔴 The model spends a round on a call that can only fail, on every turn.

### D — Whole system string cached

- 🟢 Simple; one flag.
- 🔴 The per-turn date header alone invalidates the whole prompt on every turn.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/toolOrdering.ts`, `nativeToolRegistry.ts`
  (`isOfferedThisTurn`), `toolDispatchService.ts`, `orchestrator.ts` (`buildToolsList`,
  `ORCHESTRATOR_CACHE_CONTROL`), `middleware/packages/plugin-api/src/pluginContext.ts`
  (`isAvailable`), `middleware/packages/harness-plugin-quality-guard/README.md`.
- Tests: `middleware/test/orchestrator/systemPromptCacheOrder.test.ts`,
  `toolOrderingInvariants.test.ts`, `deterministicToolOrder.test.ts`,
  `toolAvailability1346.test.ts`, `duplicateToolNames.test.ts`, `pluginToolsReadyGate.test.ts`.
- Related: ADR-0009 (MCP tool-list caching), ADR-0016 (grants).
- Border: LLM providers (cache control is passed through the provider adapters).
- Contract and pricing: `middleware/packages/llm-provider-api/src/types.ts` (`CacheHints`,
  `SystemBlock`), `middleware/packages/llm-adapter-anthropic/src/anthropicProvider.ts`
  (`cacheControl`), `middleware/packages/harness-usage-telemetry/src/pricing.ts`; tests
  `middleware/test/orchestratorLlmProviderSeam.test.ts`,
  `llmProviderAnthropicAdapter.test.ts`, `usageCacheSavingsAndFx.test.ts`.
- Related: [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md),
  [ADR-0085](0085-request-hints-degrade-in-the-adapter.md),
  [ADR-0088](0088-usage-ledger-in-usd-with-read-time-price-resolution.md).
