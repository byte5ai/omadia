-- Repurpose the dormant 1536-dim embedding column for our actual embedding
-- provider (Ollama / nomic-embed-text, 768 dims). The column was added in
-- 0001 in anticipation of OpenAI vectors but never populated — this is a
-- straight DROP + re-ADD rather than a resize because pgvector doesn't allow
-- in-place dimension changes and there's no data to preserve.

ALTER TABLE graph_nodes DROP COLUMN IF EXISTS embedding;
ALTER TABLE graph_nodes ADD COLUMN embedding vector(768);

-- HNSW instead of IVFFlat: works from zero rows, no training step, acceptable
-- quality at our current scale (<10 k turns). Can swap to IVFFlat once the
-- corpus is large enough to make training worthwhile. Partial index on Turn
-- nodes only — embeddings on other node types are possible but not our
-- current use case.
CREATE INDEX IF NOT EXISTS idx_graph_nodes_turn_embedding
  ON graph_nodes USING hnsw (embedding vector_cosine_ops)
  WHERE type = 'Turn';
