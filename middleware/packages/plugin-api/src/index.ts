export * from './pluginContext.js';
export * from './conversation.js';
export * from './limitSignal.js';
export * from './selfExtend.js';
export * from './localSubAgentTool.js';
export * from './piiAnnotation.js';

// Omadia UI canvas: the shared `TargetRef` discriminated union (beam / mutation
// / local-op / suggested-action targets) and its `TextRangeAnchor` / `BufferRegion`
// helpers. Consumed by the channel-sdk (`IncomingTurn.target`, `surface_local_action`).
export * from './targetRef.js';
// Omadia UI — write-tool capability contract + the deterministic Tier-2
// mutability derivation. Consumed by the canvas orchestrator (PR-9).
export * from './writeCapabilities.js';

// Agent Builder canvas (P0): the shared graph contract — AgentGraph, node
// DTOs, GraphEdge/EdgeKind, ModelRoutingConfig. The editable visual builder
// is a thin renderer over the config graph; backend serialises this shape
// from the registry tables and the web-ui xyflow canvas renders/mutates it.
export * from './agentGraph.js';

// S+11-1: Knowledge-graph capability contract (interface + DTOs + node-id
// helpers) lives on the plugin-api surface. Both the in-memory and the Neon
// `knowledgeGraph@1` provider plugins (S+11-2 split of @omadia/knowledge-graph)
// import the contract from here; consumers (orchestrator, verifier, extras,
// confluence, odoo) do the same. The `@omadia/knowledge-graph` package
// re-exports these symbols for backwards-compatibility until S+11-close.
export * from './entityRef.js';
export * from './entityRefBus.js';
export * from './knowledgeGraph.js';

// Phase-1 of the Kemia integration: opt-in `responseGuard@1` capability.
// Lives on the plugin-api surface so both the provider plugin
// (`harness-plugin-quality-guard`) and the orchestrator hook reach the
// same contract without a dependency between them.
export * from './responseGuard.js';

// Palaia-Phase-5 (OB-74): per-agent block/boost list, consumed by the
// `ContextRetriever.assembleForBudget` assembler. Provider:
// `harness-knowledge-graph-neon` (durable, tenant-scoped); no-op default
// for backends without a persistent layer.
export * from './agentPriorities.js';

// Privacy-Proxy: shared `PrivacyReceipt` vocabulary. The redaction itself
// is now the Privacy Shield v4 Data-Plane Boundary (@omadia/plugin-privacy-guard):
// tool results are interned server-side into a Dataset Store and only a masked
// Digest crosses the LLM wire — no external NER sidecar. The Web + Teams
// renderers build against the fixtures here.
export * from './privacyReceipt.js';
export * from './privacyReceiptFixtures.js';

// Slice 2.5 — operator-owned per-plugin Privacy Mode contract. Shared by
// the orchestrator dispatch hook (resolves mode at dispatch time) and the
// install service (injects synthetic `_privacy_mode` field into every
// plugin's setup schema).
export * from './privacyMode.js';

// Palaia-Phase-6 (OB-75): Session-Continuity Briefings. Lazy summary
// + open tasks for bootstrap system messages. Provider lives in
// `harness-orchestrator-extras` (needs KG + ContextRetriever +
// SessionSummaryGenerator).
export * from './sessionBriefing.js';

// Palaia-Phase-7 (OB-76): Process-Memory. Structured workflows with
// dedup-first-write + versioning. Provider:
// `harness-knowledge-graph-neon` (durable, tenant-scoped). Consumers:
// `harness-orchestrator` (4 native tools).
export * from './processMemory.js';

// Palaia-Phase-8 (OB-77): Nudge pipeline. Plugin-contributed nudge providers
// attach `<nudge>` blocks to tool_results. Lifecycle (success_streak,
// suppressed_until, retired_at) lives in the `nudge_state` + `nudge_emissions`
// tables. Provider: `harness-knowledge-graph-neon` (durable). Registry
// provider: `harness-orchestrator` (in-memory, plugin-extensible).
export * from './nudge.js';

// Phase 5B: kernel-published RoutinesIntegration service contract. Channel
// plugins (Teams etc.) consume the routines feature via ctx.services so the
// dynamic-import / plugin-store flow stays clean (no constructor-injected
// Deps).
export * from './routinesIntegration.js';

// Cold-start proactive 1:1: shared delivery-target model (ColdStartTarget,
// RoutineRecipient, type guards) so the routines kernel and channel plugins
// agree on the shape of a deferred, not-yet-resolved recipient.
export * from './routineTarget.js';

// KG-ACL Slice 4a: Palaia-Excerpt-Extractor capability. Haiku-backed
// per-turn enrichment producing {suggestedKind, suggestedSummary,
// suggestedRationale?, excerpts[]}. Streamed via the orchestrator's
// `done` event so the chat-side save-as-memory modal can pre-fill,
// and (Slice 4b) consumed by the auto-promotion hook so manual and
// automatic MemorableKnowledge creations share the same payload shape.
// Provider lives in `harness-orchestrator-extras/src/excerptExtractor.ts`.
export * from './palaiaExcerpt.js';

// KG-ACL Slice 8: retrospective bulk score + promotion. Operator-
// triggered admin endpoint that scores historical Turns with
// significance=NULL via the existing Haiku scorer and promotes those
// crossing threshold via the existing promoteTurnIfSignificant
// pipeline. Provider lives in `harness-orchestrator-extras/src/
// bulkPromotion.ts`.
export * from './bulkPromotion.js';

// KG-ACL Slice 9: contradiction detection on MemorableKnowledge.
// Two semantically-similar MKs with disagreeing content become an
// `Inconsistency` node + two `CONFLICTS_WITH` edges. Operator
// resolves manually via /admin/inconsistencies. Provider lives in
// `harness-orchestrator-extras/src/inconsistencyDetector.ts`.
export * from './inconsistency.js';

// KG-ACL Slice 9.5: operator-triggered bulk pass over MemorableKnowledge
// rows that have an embedding but no `last_inconsistency_check_at`
// marker yet — surfaces contradictions in memories that predate
// Slice 9. Reuses the existing detector; idempotent via marker. Provider
// lives in `harness-orchestrator-extras/src/bulkInconsistency.ts`.
export * from './bulkInconsistency.js';

// KG-ACL Slice 10: MK-Auto-Merge. Near-duplicate MKs (cosine ≥ 0.95)
// become a `MergeCandidate` node + two `DUPLICATE_OF` edges. Operator
// resolves keep_a / keep_b / not_duplicate via /admin/duplicates.
// Cosine-only detection (no Haiku) → cost-free. Provider lives in
// `harness-orchestrator-extras/src/mergeCandidateDetector.ts` and
// `harness-orchestrator-extras/src/bulkMergeDetect.ts`.
export * from './mergeCandidate.js';

// KG-ACL Slice 11: Topic clustering. Operator-triggered pass that
// clusters MemorableKnowledge nodes by their embedding (connected-
// components on cosine ≥ threshold) and gives each cluster a Haiku
// name. Provider lives in `harness-orchestrator-extras/src/
// topicClustering.ts`.
export * from './topic.js';

// KG-ACL Slice 12: ExcerptMergeCandidate. Near-duplicate PalaiaExcerpt
// detection (cosine ≥ 0.97) — mirror of Slice 10 at the excerpt layer.
// Operator resolves keep_a / keep_b / not_duplicate via
// /admin/duplicates (Excerpts tab); keep_a/keep_b deletes the loser
// excerpt via the new `deleteExcerpt` KG method.
export * from './excerptMerge.js';
