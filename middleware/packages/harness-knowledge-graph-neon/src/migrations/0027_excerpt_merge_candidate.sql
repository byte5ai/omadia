BEGIN;

-- Slice 12 — ExcerptMergeCandidate persistence (near-duplicate Excerpts
-- with cosine ≥ 0.97). Reuses graph_nodes (type='ExcerptMergeCandidate')
-- and graph_edges (type='DUPLICATE_EXCERPT_OF') — direct mirror of the
-- Slice 10 MergeCandidate pattern.

CREATE INDEX IF NOT EXISTS graph_edges_duplicate_excerpt_of_idx
  ON graph_edges (tenant_id, to_node)
  WHERE type = 'DUPLICATE_EXCERPT_OF';

ALTER TABLE graph_nodes
  DROP CONSTRAINT IF EXISTS graph_nodes_excerpt_merge_status_chk;

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_excerpt_merge_status_chk CHECK (
    type <> 'ExcerptMergeCandidate'
    OR (
      properties ? 'status'
      AND properties->>'status' IN ('open', 'resolved', 'dismissed')
    )
  );

-- Bulk excerpt-merge unchecked partial index (independent marker from
-- Slice 10 MK-merge).
CREATE INDEX IF NOT EXISTS graph_nodes_excerpt_merge_unchecked_idx
  ON graph_nodes (tenant_id, created_at ASC)
  WHERE type = 'PalaiaExcerpt'
    AND embedding IS NOT NULL
    AND NOT (properties ? 'last_excerpt_merge_check_at');

-- Extend the memory_acl_audit action CHECK to cover the new
-- `delete_excerpt` action emitted by `deleteExcerpt`. The earlier
-- migrations grew this enum once already (Slice 6.5 added
-- `edit_excerpt`); the constraint is now re-stated in full so the
-- partial-history of edits is captured in one place.
ALTER TABLE memory_acl_audit
  DROP CONSTRAINT IF EXISTS memory_acl_audit_action_chk;

ALTER TABLE memory_acl_audit
  ADD CONSTRAINT memory_acl_audit_action_chk CHECK (
    action IN (
      'create', 'expand', 'shrink', 'delete',
      'edit', 'edit_excerpt', 'delete_excerpt'
    )
  );

COMMIT;
