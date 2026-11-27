/**
 * #1815 / ADR-0194 — the per-call embedding-client source lives in
 * `@omadia/embeddings` so orchestrator-extras and the orchestrator share
 * one definition. Re-exported here for the existing imports.
 */
export type { EmbeddingClientSource } from '@omadia/embeddings';
export { currentEmbeddingClient } from '@omadia/embeddings';
