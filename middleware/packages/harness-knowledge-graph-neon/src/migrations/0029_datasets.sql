-- Issue #430 — structured dataset ingestion. Relational sidecar in the same
-- Neon pool (NOT graph-node explosion): `datasets` carries one row per
-- imported file (tenant/owner scoping, inferred column schema as JSONB);
-- `dataset_rows` carries one row per imported data row (JSONB payload).
-- Individual rows are NEVER promoted to graph nodes — only the parent
-- dataset gets a single `PluginEntity` (system='dataset') node for
-- recall/citation linking (see NeonKnowledgeGraph.ingestDataset), matching
-- the existing warning on `ingestEntities`/`ingestFacts` that node
-- properties are GIN-indexed and must stay small.
--
-- Raw uploaded file bytes live in Tigris (precedent: migration
-- 0013_teams_attachments.sql); `source_storage_key` below is that
-- object's key, not the bytes themselves.

CREATE TABLE IF NOT EXISTS datasets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,
  owner_omadia_user_id TEXT NOT NULL,
  name                TEXT NOT NULL,
  source_file_name    TEXT NOT NULL,
  source_storage_key  TEXT NULL,
  row_count           INTEGER NOT NULL DEFAULT 0,
  columns             JSONB NOT NULL DEFAULT '[]'::jsonb,
  graph_node_external_id TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_datasets_tenant_owner
  ON datasets (tenant_id, owner_omadia_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dataset_rows (
  id          BIGSERIAL PRIMARY KEY,
  dataset_id  UUID NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  row_index   INTEGER NOT NULL,
  data        JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset
  ON dataset_rows (dataset_id, row_index);

-- Query/aggregate hot path: `query_dataset` filters on arbitrary column
-- values inside `data`. A single GIN index over the whole JSONB column
-- covers containment (`@>`) and existence (`?`) lookups reasonably well
-- for CSV-scale datasets without needing a per-column index per import.
CREATE INDEX IF NOT EXISTS idx_dataset_rows_data_gin
  ON dataset_rows USING GIN (data);
