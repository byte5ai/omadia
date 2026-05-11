-- Full-text search over Turn nodes' userMessage + assistantAnswer.
-- Expression index on the existing JSONB properties so no ALTER TABLE or
-- backfill is needed. 'simple' config keeps us dictionary-free (works on
-- Neon without extra extensions) and tokenises German well enough for
-- recall; ranking is handled in the query.

CREATE INDEX IF NOT EXISTS idx_graph_nodes_turn_fts
  ON graph_nodes USING GIN (
    to_tsvector(
      'simple',
      coalesce(properties->>'userMessage', '') || ' ' ||
      coalesce(properties->>'assistantAnswer', '')
    )
  )
  WHERE type = 'Turn';

-- Trigram index for cheap case-insensitive substring search over entity
-- display labels and ids. Used by findEntitiesByLabel for the candidate
-- matcher ("open invoices from BÄR GmbH" → OdooEntity where displayName
-- ILIKE '%BÄR%'). pg_trgm ships with every Postgres install; Neon enables
-- it on demand via CREATE EXTENSION.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_graph_nodes_entity_display_trgm
  ON graph_nodes USING GIN ((properties->>'displayName') gin_trgm_ops)
  WHERE type IN ('OdooEntity', 'ConfluencePage');

CREATE INDEX IF NOT EXISTS idx_graph_nodes_entity_id_trgm
  ON graph_nodes USING GIN ((properties->>'id') gin_trgm_ops)
  WHERE type IN ('OdooEntity', 'ConfluencePage');
