BEGIN;

-- Slice 10 — MergeCandidate persistence (near-duplicates with cosine ≥
-- 0.95). Reuses graph_nodes (type='MergeCandidate') and graph_edges
-- (type='DUPLICATE_OF') — no new table, mirrors the Slice 9
-- Inconsistency pattern.

CREATE INDEX IF NOT EXISTS graph_edges_duplicate_of_idx
  ON graph_edges (tenant_id, to_node)
  WHERE type = 'DUPLICATE_OF';

ALTER TABLE graph_nodes
  DROP CONSTRAINT IF EXISTS graph_nodes_merge_candidate_status_chk;

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_merge_candidate_status_chk CHECK (
    type <> 'MergeCandidate'
    OR (
      properties ? 'status'
      AND properties->>'status' IN ('open', 'resolved', 'dismissed')
    )
  );

-- Bulk merge-detect partial index (Slice-9.5 pattern, separate marker
-- so the inconsistency- and merge-bulk passes are independent).
CREATE INDEX IF NOT EXISTS graph_nodes_mk_merge_unchecked_idx
  ON graph_nodes (tenant_id, created_at ASC)
  WHERE type = 'MemorableKnowledge'
    AND embedding IS NOT NULL
    AND NOT (properties ? 'last_merge_check_at');

COMMIT;
