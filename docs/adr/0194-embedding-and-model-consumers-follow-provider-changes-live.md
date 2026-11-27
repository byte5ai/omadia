# 0194 — Embedding and model consumers follow provider changes live

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W03-04 (issues #1815, #1817, #1855), autonomous rollout
  mandate of 2026-11-23
- **Supersedes:** —
- **Refines:** [ADR-0080](0080-embedding-providers-one-active-declared-vector-space.md)
  ("switching is live") and [ADR-0082](0082-model-refs-classes-and-live-model-discovery.md)
  (class refs and live model discovery)

## Context and Problem Statement

ADR-0080 lets an operator reactivate, switch or uninstall the `embeddingClient@1` provider
without a restart, and ADR-0082 lets live model discovery replace the built-in model
catalog after boot. Both promise a live change, but the consumers did not follow:

- `@omadia/orchestrator-extras` read `embeddingClient` once in `activate()` and handed it
  to recall, merge and contradiction detection and topic detection. After a successful
  **Reactivate provider** these features ran without vectors, and after a switch they ran
  with the previous model, until the next restart (#1815).
- The knowledge-graph gate re-ran only from the admin `/reactivate` and `/switch` routes.
  After an uninstall or deactivation the stores and the backfill sweep kept embedding with
  the removed provider's client. An OpenAI-compatible client still held its key and base
  URL, so turn text kept going to that API, while `/health` already reported embeddings
  off (#1817).
- The recall relevance judge resolved `class:fast` once in `activate()`. After a restart it
  ran on the seed's fast model, after any reactivation on the discovered one (#1855).

The question: how does a long-lived consumer of a model service or a model class stay on
the provider and model that are active now?

## Decision Drivers

- ADR-0080's "switching is live" must hold for every consumer, not only the knowledge graph.
- A removed provider receives no further request (ADR-0019 information flow; ADR-0084
  credentials).
- The knowledge-graph gate's rule stays: the approved client moves to a new client only
  together with a verdict computed for it (`gateReevaluation.ts`, ADR-0121).
- No new plugin-api contract and no plugin rebuild; the kernel can enforce it for every
  adapter, including third-party ones.

## Considered Options

- **A — Resolve per call, re-gate on withdrawal, refuse through withdrawn services.**
- **B — Reactivate every consumer plugin when the provider changes.**
- **C — Keep the boot capture and tell the operator to restart.**

## Decision Outcome

Chosen option: **A**, because it makes the change visible on the next call without
tearing down plugins that other plugins captured (ADR-0163, #1394), and the kernel can
enforce the refusal without trusting each adapter.

1. **Consumers resolve per call.** A consumer that holds an embedding client or a
   class-ref model for longer than one call resolves it at the call, the way
   `decisionModel@1` already was. In orchestrator-extras the context retriever, the
   inconsistency and merge-candidate detectors (and with them the bulk merge services) and
   the topic detector take an `EmbeddingClientSource` (a client or a resolver, exported by
   `@omadia/embeddings`). In the orchestrator the `query_knowledge_graph` tool's
   `search_turns_semantic` and the durable-rules promotion hook take the same resolver, so
   after an uninstall they answer "embeddings not configured" / promote without a vector
   instead of calling a withdrawn client. The topic detector is published whenever an LLM is available
   and answers continue-default while no provider is published. `memoryFeatureStatus@1`
   reports the topic detector's state at read time. The recall judge's default model is a
   resolver over `class:fast`; an operator-set `kg_recall_relevance_judge_model` stays
   fixed.
2. **Withdrawal re-evaluates the gate.** Every read of the knowledge-graph gate's approved
   client, write verdict or epoch first checks that the registry still publishes the
   approved client. If not, it withdraws in one synchronous block (no approved client, a
   new epoch, writes off, backfill stood down) and then re-evaluates in place against the
   registry. A new client is approved only through that re-evaluation. A backfill embed
   that fails after the epoch moved stops the batch without counting an attempt.
3. **Withdrawn model services refuse.** When a provider's `provide()` registration of a
   gated model service (`embeddingClient`, `transcription`, `decisionModel`) is disposed,
   the kernel marks that wrapper withdrawn. Every later model call through a reference
   someone still holds rejects with `ModelServiceWithdrawnError` and never reaches the
   adapter. The same holds for a `replace()` registration that wrapped such a service:
   its dispose restores the previous provider and withdraws the replacement wrapper (only a
   wrapper the `replace()` itself created; a gated wrapper handed back in stays live).

### Consequences

- 🟢 **Good:** Reactivate, switch and uninstall take effect for recall, duplicate and
  contradiction detection, topic detection, the orchestrator's semantic turn search and
  durable-rule promotion, and the knowledge graph on the next call.
- 🟢 **Good:** A removed provider gets no further request, whatever the adapter's own
  `close()` does.
- 🟢 **Good:** The recall judge runs on the same fast model after a restart as after a
  reactivation.
- 🔴 **Bad:** One registry lookup per embed and per judge call (a map read).
- 🔴 **Bad:** The extras consumers still use the registry's client, not the knowledge-graph
  gate's approved one. While the gate blocks a provider, their vector queries fail inside
  their existing `try/catch` and recall is lexical only, as before.
- 🔴 **Bad:** A per-caller factory registration (`perCallerService`) is a function, not a
  gated object, so the kernel cannot mark what it returned as withdrawn. No model service
  is registered that way today; one that is would rely on its consumers resolving per call.
- ⚪ **Neutral:** An embed in the knowledge-graph stores that is in flight at the moment of
  a withdrawal can still count one attempt on that node; the backfill re-embeds it within
  the attempt cap.

## Pros and Cons of the Options

### A — Resolve per call, re-gate on withdrawal, refuse through withdrawn services

- 🟢 No plugin teardown; works for every adapter; one kernel rule.
- 🔴 Every consumer has to be written to resolve late; a new consumer that captures can
  regress it (the refusal in point 3 then turns the silent egress into a visible error).

### B — Reactivate every consumer plugin when the provider changes

- 🟢 No consumer code changes.
- 🔴 The orchestrator captures extras' services; rebuilding extras alone changes nothing
  for it (#1394), and rebuilding the orchestrator on every provider change is heavy.
- 🔴 Needs a provider-change hook the kernel does not have.

### C — Keep the boot capture and tell the operator to restart

- 🟢 No code.
- 🔴 Contradicts ADR-0080 and keeps the egress to a removed provider.

## More Information

- Code: `middleware/packages/harness-embeddings/src/liveEmbeddingClient.ts`,
  `middleware/packages/harness-orchestrator/src/{plugin,knowledgeGraphTool,durableRulesMemoryStore}.ts`,
  `middleware/packages/harness-orchestrator-extras/src/{plugin,contextRetriever,inconsistencyDetector,mergeCandidateDetector,topicDetector,recallRelevanceJudge}.ts`,
  `middleware/packages/harness-knowledge-graph-neon/src/{gateReevaluation,embeddingBackfill}.ts`,
  `middleware/src/platform/{modelGatewayServices,serviceRegistry}.ts`.
- Tests: `middleware/test/embeddingLiveRebind1815.test.ts`.
- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md),
  [ADR-0121](0121-one-embedding-model-per-vector-space.md),
  [ADR-0163](0163-agent-runtimes-built-from-config-snapshot-and-reloaded-by-diff.md).
