BEGIN;

-- Slice 6.5 — PalaiaExcerpt persistence.
--
-- Excerpts live as `graph_nodes` rows with type='PalaiaExcerpt' and an
-- `EXCERPT_OF` edge pointing from the excerpt to its parent
-- MemorableKnowledge. No new table — keeps the polymorphic-graph
-- invariant (every entity is a graph_nodes row).
--
-- Two schema-level guarantees added here:
--   1) An index for the "list excerpts of MK" hot path so detail-page
--      loads stay sub-millisecond even at scale.
--   2) A CHECK constraint that keeps PalaiaExcerpt rows well-formed —
--      `position` must be present and in [0, 4] (matches Slice-4a hard
--      cap of 5 excerpts per turn).
--
-- The CHECK uses a guard `type <> 'PalaiaExcerpt' OR …` so it is
-- silently skipped for every other node type. Existing rows (none of
-- them PalaiaExcerpt yet) trivially satisfy the constraint.

-- Hot-path index: "give me all excerpts of MK X". Partial because
-- EXCERPT_OF is the only edge type that needs this lookup pattern.
CREATE INDEX IF NOT EXISTS graph_edges_excerpt_of_idx
  ON graph_edges (tenant_id, to_node)
  WHERE type = 'EXCERPT_OF';

-- Sanity-check: PalaiaExcerpt nodes must carry a numeric position in
-- [0, 4]. Matches L_s6.5.5 hard cap (max 5 excerpts per parent MK).
ALTER TABLE graph_nodes
  DROP CONSTRAINT IF EXISTS graph_nodes_palaia_excerpt_position_chk;

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_palaia_excerpt_position_chk CHECK (
    type <> 'PalaiaExcerpt'
    OR (
      properties ? 'position'
      AND jsonb_typeof(properties->'position') = 'number'
      AND (properties->>'position')::int BETWEEN 0 AND 4
    )
  );

COMMIT;
