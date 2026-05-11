export * from './pluginContext.js';
export * from './conversation.js';
export * from './localSubAgentTool.js';

// Knowledge-graph capability contract (interface + DTOs + node-id helpers)
// lives on the plugin-api surface. Both the in-memory and the Postgres
// `knowledgeGraph@1` provider plugins import the contract from here, as do
// downstream consumers (orchestrator, verifier, extras, and any integration
// plugin that ingests entities).
export * from './entityRef.js';
export * from './entityRefBus.js';
export * from './knowledgeGraph.js';

// Phase-1 of the Kemia integration: opt-in `responseGuard@1` capability.
// Lives on the plugin-api surface so both the provider plugin
// (`harness-plugin-quality-guard`) and the orchestrator hook reach the
// same contract without a dependency between them.
export * from './responseGuard.js';

// Palaia-Phase-5 (OB-74): per-Agent Block/Boost-Liste, konsumiert vom
// `ContextRetriever.assembleForBudget`-Assembler. Provider:
// `harness-knowledge-graph-neon` (durable, tenant-scoped); No-Op-Default
// für Backends ohne persistente Schicht.
export * from './agentPriorities.js';

// Privacy-Proxy Slice 1a: shared `PrivacyReceipt` vocabulary. Slice 1b
// will land the wrapper + Presidio detector + tokenise-map roundtrip;
// Slices 5/6 (Web + Teams renderers) build against the fixtures here so
// they can ship in parallel.
export * from './privacyReceipt.js';
export * from './privacyReceiptFixtures.js';

// Palaia-Phase-6 (OB-75): Session-Continuity Briefings. Lazy-Summary
// + offene Tasks für Bootstrap-System-Messages. Provider lebt in
// `harness-orchestrator-extras` (braucht KG + ContextRetriever +
// SessionSummaryGenerator).
export * from './sessionBriefing.js';

// Palaia-Phase-7 (OB-76): Process-Memory. Strukturierte Workflows mit
// Dedup-First-Write + Versioning. Provider:
// `harness-knowledge-graph-neon` (durable, tenant-scoped). Konsumenten:
// `harness-orchestrator` (4 native Tools).
export * from './processMemory.js';

// Palaia-Phase-8 (OB-77): Nudge-Pipeline. Plugin-contributed Nudge-Provider
// hängen `<nudge>`-Blöcke an tool_results. Lifecycle (success_streak,
// suppressed_until, retired_at) lebt in `nudge_state` + `nudge_emissions`
// Tabellen. Provider: `harness-knowledge-graph-neon` (durable). Registry-
// Provider: `harness-orchestrator` (in-memory, plugin-extensible).
export * from './nudge.js';

// Phase 5B: kernel-published RoutinesIntegration service contract. Channel
// plugins (Teams etc.) consume the routines feature via ctx.services so the
// dynamic-import / plugin-store flow stays clean (no constructor-injected
// Deps).
export * from './routinesIntegration.js';
