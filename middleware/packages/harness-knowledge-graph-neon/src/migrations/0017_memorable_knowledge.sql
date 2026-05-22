BEGIN;

-- Slice 2 — MemorableKnowledge Node-Type. New `type` value enforced via
-- the Zod validator (schema.ts); no DDL on graph_nodes needed because
-- the single-table-discriminator architecture carries it.
--
-- Two partial indexes for the typical query paths:
--   1. kind-filtered list ("show me all my decisions").
--   2. significance-ordered list ("most-significant MKs first").
--
-- Additive — safe to apply on a non-empty graph_nodes table.

CREATE INDEX IF NOT EXISTS idx_memorable_kind
  ON graph_nodes (tenant_id, (properties->>'kind'))
  WHERE type = 'MemorableKnowledge';

CREATE INDEX IF NOT EXISTS idx_memorable_significance
  ON graph_nodes (
    tenant_id,
    (((properties->>'significance')::float)) DESC NULLS LAST
  )
  WHERE type = 'MemorableKnowledge'
    AND properties->>'significance' IS NOT NULL;

COMMIT;
