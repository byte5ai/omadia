-- 0001_graph_init.sql
-- Knowledge-graph + agentic-run-graph storage on Neon Postgres.
-- Schema is backend-agnostic: every node/edge carries its type as text so new
-- node/edge kinds never require a migration. Tenancy and scope columns are
-- first-class from day one so multi-tenant + per-conversation filtering stays
-- a WHERE-clause instead of a schema migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS graph_nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   TEXT NOT NULL,
  type          TEXT NOT NULL,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  scope         TEXT,
  properties    JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding     VECTOR(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT graph_nodes_ext_unique UNIQUE (tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS graph_nodes_type_idx
  ON graph_nodes (tenant_id, type);
CREATE INDEX IF NOT EXISTS graph_nodes_scope_idx
  ON graph_nodes (tenant_id, scope, type) WHERE scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_nodes_props_gin
  ON graph_nodes USING GIN (properties);
CREATE INDEX IF NOT EXISTS graph_nodes_created_idx
  ON graph_nodes (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS graph_edges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  from_node     UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node       UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  properties    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT graph_edges_dedupe UNIQUE (tenant_id, from_node, to_node, type)
);

CREATE INDEX IF NOT EXISTS graph_edges_from_idx
  ON graph_edges (tenant_id, from_node, type);
CREATE INDEX IF NOT EXISTS graph_edges_to_idx
  ON graph_edges (tenant_id, to_node, type);

CREATE OR REPLACE FUNCTION graph_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS graph_nodes_set_updated_at ON graph_nodes;
CREATE TRIGGER graph_nodes_set_updated_at
  BEFORE UPDATE ON graph_nodes
  FOR EACH ROW EXECUTE FUNCTION graph_set_updated_at();
