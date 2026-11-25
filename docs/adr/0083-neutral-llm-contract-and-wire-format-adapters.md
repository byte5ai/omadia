# 0083 — One neutral LLM contract; vendor SDKs live only in wire-format adapters

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; adapter registry from #298, model call gate from #2090)
- **Supersedes:** —

## Context and Problem Statement

[ADR-0003](0003-capability-based-multi-provider-middleware.md) decided that the core
depends on capability interfaces and not on vendors. It does not say what the LLM
interface looks like, where vendor SDK code may live, or how a new provider is added.
The middleware began on the Anthropic SDK, and the orchestrator's tool loop still builds
and reads Anthropic-shaped messages. How does text generation become provider-neutral
without rewriting that loop, and what must every provider implementation do? This record
is retroactive: it describes what is implemented on main.

## Decision Drivers

- No package outside an adapter may depend on a vendor SDK or a vendor message shape.
- Adding a provider that speaks a known protocol must need no code, only data.
- A provider implementation cannot be allowed to forget the kernel's model call gate
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).
- The orchestrator loop is large and loosely typed; a rewrite to new types is where a
  refactor without behaviour change goes wrong.

## Considered Options

- **A — Neutral contract package, adapters keyed by wire format, declarative provider descriptors**
- **B — Adapters keyed by provider id** (one adapter package per vendor)
- **C — Keep the Anthropic SDK shape as the internal interface and convert other vendors to it**

## Decision Outcome

Chosen option: **A**.

- **Three layers.** `@omadia/llm-provider-api` is the contract (neutral DTOs in
  `types.ts`, `LlmAdapter` / `LlmAdapterRegistry` in `adapter.ts`, `LlmProviderDescriptor`
  in `descriptor.ts`, model types in `models.ts`). `@omadia/llm-provider` is the runtime
  (adapter registry, provider catalog, factory, pool, model registry) and imports no
  vendor SDK. `@omadia/llm-adapter-*` packages hold the SDKs and the wire mapping.
- **Vendor SDK imports are a lint error everywhere else.** `middleware/eslint.config.mjs`
  restricts `@anthropic-ai/sdk` and `openai` and exempts only
  `packages/llm-adapter-anthropic` and `packages/llm-adapter-openai`. Adapters that need
  one request (OpenAI Responses over SSE, embeddings, transcription) write it by hand
  instead of widening the exemption.
- **Adapters are keyed by wire format, not by provider id.** `WireFormat` is
  `openai-compatible | anthropic | claude-cli | openai-responses`. A provider that
  speaks an existing format is a descriptor only: id, label, `baseURL`, `quirks`,
  `policy`, models, optional `discovery`. It comes from a plugin manifest's
  `llm_provider` block (`src/platform/llmProviderManifest.ts`) or from the bundled
  built-ins (`src/platform/builtinLlmProviders.ts`). Vendor deviations from plain OpenAI
  are `ProviderQuirks` flags (`maxTokensField`, `dropToolChoice`, `checkBaseResp`,
  `extraBody`), not a new adapter. Only a new protocol needs a new adapter package.
- **Resolution is a registry lookup.** `resolveLlmProvider` (`providerFactory.ts`) reads
  the descriptor's wire format, takes the adapter from the registry and calls
  `adapter.build()`. It returns the raw provider, or `undefined` when no credential is
  configured; usage tracking is layered on by the caller.
- **The orchestrator loop keeps its Anthropic-shaped internal format** and translates
  only at the provider boundary (`harness-orchestrator/src/llmProviderSeam.ts`:
  `toLlmRequest` / `fromLlmResponse`).
- **Every provider calls `admitModelCall(operation)` before it reaches its backend**,
  once per `complete()` and once per `stream()`; its own retries of one request are one
  call. The function lives in the contract package (`modelCallGate.ts`) so that a
  provider cannot be written without seeing it; what the gate does is installed by the
  host. Its refusal errors are never retried and never become a helper's silent fallback
  (`isModelCallNotCovered`).
- **The contract is versioned** (`LLM_PROVIDER_API_VERSION`, `1.6.0` on main): major on a
  breaking change to an exported type, minor on an addition.
- `LlmProvider` in `@omadia/plugin-api` (the narrow `ctx.llm` surface) is a consumer of
  this contract, not a second contract.

### Consequences

- 🟢 **Good:** OpenAI, Mistral and MiniMax run on one adapter; a new compatible provider
  is a manifest block.
- 🟢 **Good:** The gate, error classification and usage shape are the same for every
  provider, so fallback and metering need no vendor branch.
- 🔴 **Bad:** The orchestrator still thinks in Anthropic blocks; every request crosses two
  mappings (loop → neutral → vendor), and a neutral feature the loop cannot express has to
  be added in the seam as well.
- 🔴 **Bad:** Vendor preview features need an escape hatch (`LlmRequest.betas`), which is
  provider-specific data in a neutral type.
- 🔴 **Bad:** The gate depends on each adapter calling it. A third-party adapter that does
  not call `admitModelCall` runs past the gateway; nothing on main detects that.
- ⚪ **Neutral:** `claude-cli` is a wire format although it is not HTTP; see
  [ADR-0086](0086-subscription-logins-as-providers.md).

## Pros and Cons of the Options

### A — Neutral contract, wire-format adapters, descriptors

- 🟢 New providers without code; SDKs confined by lint; one gate.
- 🔴 Quirk flags grow with every vendor deviation.

### B — Adapters keyed by provider id

- 🟢 Each vendor's oddities stay in its own package.
- 🔴 Every OpenAI-compatible vendor repeats the same mapping; a plugin must ship code to
  add a provider.

### C — Anthropic shape as the internal interface

- 🟢 No change to the orchestrator loop and no seam.
- 🔴 Every other vendor is expressed in one vendor's terms; the SDK types spread through
  all packages.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md), [ADR-0082](0082-model-refs-classes-and-live-model-discovery.md),
  [ADR-0085](0085-request-hints-degrade-in-the-adapter.md).
- Paths: `middleware/packages/llm-provider-api/src/`, `middleware/packages/llm-provider/src/{adapterRegistry,providerCatalog,providerFactory}.ts`,
  `middleware/packages/llm-adapter-{anthropic,openai,openai-responses}/src/`, `middleware/eslint.config.mjs`.
- Tests: `middleware/test/llmProviderFactory.test.ts`, `llmProviderPluginRegistration.test.ts`,
  `llmProviderManifestDiscovery.test.ts`, `llmProviderMinimaxQuirks.test.ts`,
  `orchestratorLlmProviderSeam.test.ts`, `modelGatewayCallSites.test.ts`.
