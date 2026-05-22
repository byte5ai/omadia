BEGIN;

-- Slice 9 — Inconsistency persistence. Re-uses graph_nodes
-- (type='Inconsistency') and graph_edges (type='CONFLICTS_WITH').
-- No new table — keeps the polymorphic-graph invariant.
--
-- Hot-path index for "all inconsistencies touching this MK"
-- (operator's /admin/inconsistencies and the dedupe check before
-- creating a new one).

CREATE INDEX IF NOT EXISTS graph_edges_conflicts_with_idx
  ON graph_edges (tenant_id, to_node)
  WHERE type = 'CONFLICTS_WITH';

-- Status enum CHECK (analogous to the position-CHECK on PalaiaExcerpt).
ALTER TABLE graph_nodes
  DROP CONSTRAINT IF EXISTS graph_nodes_inconsistency_status_chk;

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_inconsistency_status_chk CHECK (
    type <> 'Inconsistency'
    OR (
      properties ? 'status'
      AND properties->>'status' IN ('open', 'resolved', 'dismissed')
    )
  );

COMMIT;
