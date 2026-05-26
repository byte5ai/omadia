BEGIN;

-- Slice 7 — partial indexes for the embedding-backfill scan on
-- MemorableKnowledge + PalaiaExcerpt nodes. Mirror of the Turn index
-- declared in 0006_embedding_backfill_state.sql.
--
-- The embedding / embedding_attempts / embedding_last_error_at
-- columns themselves are already present — added globally to
-- graph_nodes by 0006. This migration only adds the per-type lookup
-- indexes so the generalized backfill sweep stays sub-millisecond
-- as the MK + Excerpt corpora grow.

CREATE INDEX IF NOT EXISTS idx_graph_nodes_mk_embedding_pending
  ON graph_nodes (embedding_attempts, id)
  WHERE type = 'MemorableKnowledge' AND embedding IS NULL;

CREATE INDEX IF NOT EXISTS idx_graph_nodes_excerpt_embedding_pending
  ON graph_nodes (embedding_attempts, id)
  WHERE type = 'PalaiaExcerpt' AND embedding IS NULL;

COMMIT;
