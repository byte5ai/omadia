BEGIN;

-- Slice 11 — Topic clustering persistence. Reuses graph_nodes
-- (type='Topic') and graph_edges (type='HAS_TOPIC') — no new tables.

CREATE INDEX IF NOT EXISTS graph_edges_has_topic_idx
  ON graph_edges (tenant_id, to_node)
  WHERE type = 'HAS_TOPIC';

CREATE INDEX IF NOT EXISTS graph_edges_has_topic_from_idx
  ON graph_edges (tenant_id, from_node)
  WHERE type = 'HAS_TOPIC';

ALTER TABLE graph_nodes
  DROP CONSTRAINT IF EXISTS graph_nodes_topic_name_chk;

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_topic_name_chk CHECK (
    type <> 'Topic'
    OR (
      properties ? 'name'
      AND length(properties->>'name') BETWEEN 1 AND 200
    )
  );

COMMIT;
