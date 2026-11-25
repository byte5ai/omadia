# 0080 — One active embedding provider; it declares its vector space, and a switch discards the stored vectors only on explicit confirmation

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #440 pluggable embeddings and gate, #1003 / OM-84 keyless adapter, OM-98 dedup threshold)
- **Supersedes:** —

## Context and Problem Statement

[ADR-0003](0003-capability-based-multi-provider-middleware.md) allows several providers
per capability. For embeddings that is unsafe: a `vector(n)` column is one cosine space,
and two models writing into it do not fail, recall just gets worse for as long as nobody
notices. The embedding interface also lived inside the Ollama adapter, so a second
provider would have depended on that package, and users on a subscription login had
neither an Ollama server nor an API key. How do embedding providers plug in without
mixing vector spaces, and what happens to the stored vectors when the provider changes?
This record is retroactive. It borders the knowledge-graph domain, which owns the gate.

## Decision Drivers

- Mixed vector spaces must be impossible, not merely discouraged.
- A missing provider must degrade features, not fail the boot.
- Re-embedding a corpus costs one provider call per row; it must not start by accident.
- A path with no key, no server and no account has to exist.

## Considered Options

- **A — Exactly one active provider, provider metadata on the contract, a gate in the knowledge graph, confirmed discard on switch**
- **B — Several providers at once, a vector column or index per model**
- **C — One fixed embedding model for every install**

## Decision Outcome

Chosen option: **A**. For this capability it narrows ADR-0003 on purpose.

- **Contract.** `EmbeddingClient` lives in `@omadia/plugin-api`
  (`src/embeddingClient.ts`); the capability stays `embeddingClient@1`. Three bundled
  adapters of kind `model` implement it: `@omadia/embeddings` (Ollama),
  `@omadia/embedding-adapter-openai` (OpenAI wire format) and
  `@omadia/embedding-adapter-local` (in-process, no key).
- **Exactly one is active.** `ctx.services.provide` throws on a second registration. An
  adapter with a `secret` setup field is not installed automatically by the built-in
  bootstrap.
- **An unconfigured adapter activates and publishes nothing** (no base URL, no key, no
  weights). Consumers then use their no-embedding paths: full-text retrieval only, no
  topic detection.
- **A provider says what it emits:** a provider-qualified `modelId` (`ollama:…`,
  `openai:…`) and `dimensions`. Dimensions are never guessed: a known model uses its
  verified width, an unknown model needs the operator's value, and a contradiction
  between both refuses to publish. `dimensions` has no manifest default.
- **The gate** (`harness-knowledge-graph-neon/src/embeddingModelGate.ts`) runs before
  anything is written. It compares the provider with the declared column width, read from
  the catalog, and with the recorded model (`graph_embedding_model`, migration 0030).
  A width mismatch blocks. The same width with a different model clears the governed
  vector columns in bounded batches and lets the backfill re-embed. While a clear is
  pending, vector writes are refused. Decisions run under an advisory lock with a
  compare-and-set, and a cooldown refuses a switch back and forth during a rolling deploy.
- **Switching is live and needs consent.** `/api/v1/admin/embedding-provider`
  (`src/routes/adminEmbeddingProvider.ts`) deactivates the current provider, activates
  the target, verifies that it published a client, rolls back otherwise, and re-evaluates
  the gate in place. It refuses without `confirmDiscardVectors: true` and reports the
  number of vectors first. Plugin activation never gets the right to rewrite columns, so
  an upgrade and restart keeps the corpus. `auto_migrate_vector_columns` is the
  operator's switch over the confirmed path.
- **The kernel does not import the adapters.** It names them by id and reads what they
  publish; `embeddingProviderCatalog.ts` mirrors dimensions and thresholds for preview
  only.
- **The keyless adapter does not bundle its weights** (about 144 MB). They are fetched on
  demand at a pinned revision with SHA-256 digests (`fetchModel.ts`). The model
  (`paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions) was chosen by a measurement
  recorded in `localEmbeddingClient.ts`.
- **A cosine threshold belongs to the model.** Each adapter names the
  `process_dedup_threshold` it needs (0.45 for the local model against the default 0.90).
- **Every adapter limits concurrency** with the wrapper on the contract package, and
  every `embed` passes the model gateway through the service registry wrapper
  (`gateModelService`, [ADR-0017](0017-model-gateway-and-execution-contexts.md)).

### Consequences

- 🟢 **Good:** A provider swap can no longer silently degrade recall.
- 🟢 **Good:** Semantic memory works on a subscription-only install.
- 🔴 **Bad:** Per-agent or per-tenant embedding models are not possible.
- 🔴 **Bad:** Every switch costs the whole corpus: all vectors are earned again, one call
  per row, and retrieval is full-text only until the backfill is done.
- 🔴 **Bad:** The kernel's preview table duplicates adapter data and can go stale; the
  code accepts a vaguer preview, never a wrong migration.
- 🔴 **Bad:** An adapter that publishes no metadata (older or third-party) cannot be
  checked by the gate.
- ⚪ **Neutral:** `docker-compose.embeddings.yaml` adds the Ollama sidecar with
  `nomic-embed-text`; without the overlay embeddings are off and nothing fails.

## Pros and Cons of the Options

### A — One provider, declared space, gated switch

- 🟢 Correct by construction; explicit cost.
- 🔴 No mixing, even where it would be wanted.

### B — Several providers, a column per model

- 🟢 Per-agent models; no discard on switch.
- 🔴 Storage and indexes per model; every read path must choose the right space.

### C — One fixed model

- 🟢 No gate needed.
- 🔴 Forces a vendor or a server on every install.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0004](0004-knowledge-graph-as-memory-substrate.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md).
- Paths: `middleware/packages/plugin-api/src/embeddingClient.ts`,
  `middleware/packages/{harness-embeddings,embedding-adapter-openai,embedding-adapter-local}/`,
  `middleware/packages/harness-knowledge-graph-neon/src/{embeddingModelGate,embeddingBackfill}.ts`,
  `middleware/src/routes/{adminEmbeddingProvider,embeddingProviderCatalog}.ts`, `docker-compose.embeddings.yaml`.
- Tests: `middleware/test/embeddingModelGate*.test.ts`, `embeddingGateWriteFence.pg.test.ts`,
  `embeddingGateReevaluation.pg.test.ts`, `adminEmbeddingProvider*.test.ts`,
  `embeddingClientResolver.test.ts`, `localEmbeddingAdapter*.test.ts`, `localEmbeddingModelFetch.test.ts`,
  `openaiEmbeddingClient.test.ts`.
