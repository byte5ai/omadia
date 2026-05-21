export * from './pluginContext.js';
export * from './conversation.js';
export * from './localSubAgentTool.js';
export * from './piiAnnotation.js';

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

// Privacy-Proxy Slice 1a: shared `PrivacyReceipt` vocabulary. Slice 1b
// will land the wrapper + Presidio detector + tokenise-map roundtrip;
// Slices 5/6 (Web + Teams renderers) build against the fixtures here so
// they can ship in parallel.
export * from './privacyReceipt.js';
export * from './privacyReceiptFixtures.js';

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
