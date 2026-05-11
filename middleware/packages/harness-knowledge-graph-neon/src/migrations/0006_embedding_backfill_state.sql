-- Track embedding-attempt state per node so a retry scheduler can find turns
-- that entered the graph with embedding=NULL after an Ollama blip, without
-- rotating forever on permanently broken turns.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS embedding_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS embedding_last_error_at TIMESTAMPTZ NULL;

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS embedding_last_error TEXT NULL;

-- Partial index for the backfill scan: only Turn rows that still need an
-- embedding. Keeps the sweep cheap even after the corpus grows.
CREATE INDEX IF NOT EXISTS idx_graph_nodes_turn_embedding_pending
  ON graph_nodes (embedding_attempts, id)
  WHERE type = 'Turn' AND embedding IS NULL;
