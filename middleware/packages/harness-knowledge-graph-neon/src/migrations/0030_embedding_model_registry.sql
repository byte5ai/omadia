-- #440 — record which embedding model the stored vectors belong to.
--
-- graph_nodes.embedding and processes.embedding are cosine-similarity spaces.
-- Vectors produced by two different models in such a space are silent
-- garbage: no error, just steadily worse recall. Since the embedding provider
-- became pluggable there is a real way to get there (install a second
-- adapter), so the active model is now persisted per tenant and compared on
-- knowledge-graph activation.
--
-- One row per tenant — the single-active-provider rule, expressed in schema.
--
-- `clear_pending` makes a model switch resumable. Switching to a different
-- model of the SAME vector size means every stored vector has to be dropped
-- and re-embedded; that clear runs in bounded batches so activation cannot
-- stall on a large corpus, and this flag tells the embedding-backfill sweep
-- that rows are still owed. While it is TRUE the sweep clears instead of
-- re-embedding, which is what keeps "a non-NULL vector is an old-model
-- vector" true for the duration of the transition.

CREATE TABLE IF NOT EXISTS graph_embedding_model (
  tenant_id     TEXT PRIMARY KEY,
  model_id      TEXT        NOT NULL,
  dimensions    INTEGER     NOT NULL,
  clear_pending BOOLEAN     NOT NULL DEFAULT FALSE,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent for the (unreleased) installs that already applied an earlier
-- revision of this migration without the column.
ALTER TABLE graph_embedding_model
  ADD COLUMN IF NOT EXISTS clear_pending BOOLEAN NOT NULL DEFAULT FALSE;
