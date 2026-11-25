# 0082 — Models are named by class, role or qualified id; the catalog is discovered live from family rules

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; class refs after #296 and #1079, default refresh after #1359)
- **Supersedes:** —

## Context and Problem Statement

Configuration, manifests and code used to name concrete Claude model ids. With several
providers ([ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md)) a hard-coded id is wrong on
every other provider, and each new model generation needed a code change. How does a
caller name a model so that the name survives a provider switch and a new generation,
and where does the list of models come from? This record is retroactive.

## Decision Drivers

- An admin connects another provider and the orchestrator, sub-agents and builder pick
  that provider's models without editing ids.
- A new model generation must appear without a release.
- A ref that reaches a vendor API unresolved is a 404 on every call (#296, #1079).
- A fresh install without a key, and an install whose vendor API is unreachable, must
  still have a usable model list.

## Considered Options

- **A — Global registry of provider-qualified models with class tiers; live discovery by family rules over a static seed**
- **B — Static model table maintained in the code**
- **C — Free-form vendor ids in configuration, no registry**

## Decision Outcome

Chosen option: **A**.

- **Identity.** A model's primary key is `<provider>:<modelId>` (`ModelInfo.id`). The
  adapter only ever receives the bare `modelId`.
- **Three classes:** `fast`, `balanced`, `frontier`. Six roles map to a default class
  (`ROLE_DEFAULT_CLASS` in `llm-provider/src/modelRegistry.ts`: orchestrator, subagent and
  codegen = frontier, classifier and verifier = fast, preview = balanced). The builder
  slugs `opus`, `sonnet`, `haiku` are aliases.
- **Registry invariants, checked on every registration** (core and plugin models
  together): unique ids, globally unique aliases, no alias equal to an id, nothing
  starting with `class:`, exactly one `classDefault` when a provider has several models of
  a class. A violation throws instead of routing wrongly.
- **The registry ships empty** (`RAW_MODELS = []`). The app registers the bundled
  built-ins (Anthropic, OpenAI, Mistral, `claude-cli`, and the experimental
  `openai-chatgpt`) before any plugin activates; MiniMax is not bundled and comes only
  as a plugin.
- **One resolver for configured refs.** `resolveConfiguredModel`
  (`configuredModelRef.ts`) is shared by the orchestrator, dynamic sub-agents, the
  verifier, orchestrator-extras and plugin `ctx.llm`. A class ref is never passed
  through raw. When the provider serves no model of the class, the nearest class in the
  order frontier, balanced, fast is used, then any model the provider serves.
- **Live discovery.** A descriptor may declare `discovery` rules. `modelCatalogSync`
  (`src/platform/modelCatalogSync.ts`) asks the vendor's list-models API through the
  adapter's `listModels()` and applies the rules (`llm-provider/src/modelDiscovery.ts`):
  `include` / `exclude`, ordered `classify` rules that name a family and never a version,
  the newest match of a rule holds its aliases, rule order is the class-default
  preference, dated snapshots collapse onto their undated twin, retired ids are dropped.
- **The static `models` list is the offline seed.** A run with status `empty` or `failed`
  keeps the previous set; `listModels()` must throw on auth or network failure so that
  an error is not read as an empty list.
- **Triggers:** boot (not awaited), a verified key, `POST /api/v1/admin/providers/:id/refresh-models`,
  and a timer (`LLM_MODEL_DISCOVERY_INTERVAL_MS`, default 6 hours, 0 = boot only). When
  class defaults change, `onDefaultsChanged` lets consumers that resolved a class at
  activation re-resolve (#1359).
- **Prices are not in the registry.** They live in `@omadia/usage-telemetry`
  ([ADR-0088](0088-usage-ledger-in-usd-with-read-time-price-resolution.md)).

### Consequences

- 🟢 **Good:** A provider switch changes no agent configuration that uses classes, roles
  or aliases.
- 🟢 **Good:** A new Opus, Sonnet, Haiku or GPT generation becomes the class default at
  the next sync.
- 🔴 **Bad:** The model behind `class:frontier` can change without a deploy, up to 6 hours
  after the vendor lists it. Behaviour and cost move with it and nobody approved the
  change.
- 🔴 **Bad:** The nearest-class fallback can run a `class:fast` request on a frontier model
  when a provider serves nothing smaller; the call succeeds at a higher price.
- 🔴 **Bad:** The built-in descriptors duplicate the `llm_provider` blocks of the separate
  provider plugin repositories and must be kept in sync by hand
  (`builtinLlmProviders.ts` header).
- ⚪ **Neutral:** Capabilities the vendor list omits come from the seed entry, then the
  rule, then conservative defaults.

## Pros and Cons of the Options

### A — Registry, classes, live discovery over a seed

- 🟢 Version-free configuration; works offline.
- 🔴 Rules must anticipate vendor naming; a new family needs a new rule.

### B — Static table

- 🟢 Every model change is reviewed.
- 🔴 A release per model generation; stale ids fail at run time.

### C — Free-form ids

- 🟢 Nothing to maintain.
- 🔴 No class or role resolution, no validation, a typo is a 404 per call.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md), [ADR-0081](0081-model-policy-fallback-and-provider-circuit-breaker.md).
- Paths: `middleware/packages/llm-provider/src/{modelRegistry,configuredModelRef,modelDiscovery,providerCatalog}.ts`,
  `middleware/packages/llm-provider-api/src/{models,descriptor}.ts`,
  `middleware/src/platform/{builtinLlmProviders,modelCatalogSync}.ts`.
- Tests: `middleware/test/llmProviderModelRegistry.test.ts`, `llmProviderModelOverlay.test.ts`,
  `llmProviderModelDiscoveryRules.test.ts`, `llmProviderStrictModelRef.test.ts`,
  `llmClassRefGate.test.ts`, `llmProviderBuiltinShadowing.test.ts`, `modelCatalogSync.test.ts`.
