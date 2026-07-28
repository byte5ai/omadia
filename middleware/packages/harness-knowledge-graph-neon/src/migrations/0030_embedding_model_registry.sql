-- #440 — record which embedding model the stored vectors belong to.
--
-- graph_nodes.embedding is ONE cosine-similarity space. Vectors produced by
-- two different models in that space are silent garbage: no error, just
-- steadily worse recall. Since the embedding provider became pluggable there
-- is a real way to get there (install a second adapter), so the active model
-- is now persisted per tenant and compared on knowledge-graph activation.
--
-- One row per tenant — the single-active-provider rule, expressed in schema.

CREATE TABLE IF NOT EXISTS graph_embedding_model (
  tenant_id   TEXT PRIMARY KEY,
  model_id    TEXT        NOT NULL,
  dimensions  INTEGER     NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
