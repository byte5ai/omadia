BEGIN;

-- Slice 9.5 — partial index for the bulk-inconsistency-detect
-- selection. Operator triggers `/admin/inconsistencies/bulk-detect`
-- which iterates MemorableKnowledge rows that
--   (a) have an embedding (cosine candidate-search can find neighbours)
--   (b) carry no `last_inconsistency_check_at` marker yet
-- in created_at-ascending order (oldest first — most likely source of
-- historical conflicts that predate Slice 9). The marker is written by
-- `inconsistencyDetector.detectFor()` at the end of each run so a
-- re-trigger skips already-checked MKs.

CREATE INDEX IF NOT EXISTS graph_nodes_mk_inconsistency_unchecked_idx
  ON graph_nodes (tenant_id, created_at ASC)
  WHERE type = 'MemorableKnowledge'
    AND embedding IS NOT NULL
    AND NOT (properties ? 'last_inconsistency_check_at');

COMMIT;
