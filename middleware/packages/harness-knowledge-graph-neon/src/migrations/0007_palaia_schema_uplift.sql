-- Palaia-Integration · Phase 1: additive Felder für Memory-Typ-Klassifikation,
-- Visibility-Scopes, HOT/WARM/COLD-Tiering und Decay-Scoring.
-- Phase 2 (OB-71) füllt entry_type/significance über LLM-Capture-Pipeline.
-- Phase 4 (OB-73) bewirtschaftet tier/decay_score über Cron.
-- Diese Migration ändert KEIN bestehendes Verhalten — nur Felder + Defaults.
--
-- Naming-Anmerkung: Das in der Palaia-Spec genannte Feld "scope" (visibility:
-- private/team/public/shared) heißt hier `visibility`, weil `graph_nodes.scope`
-- bereits seit 0001 für den Session-Scope (z.B. 'demo', 'meet-acme') belegt
-- ist. Die Plugin-API bildet das auf den Type `Visibility` ab.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'memory'
    CHECK (entry_type IN ('memory', 'process', 'task'));

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team';
  -- Werte: 'private' | 'team' | 'public' | 'shared:<project>'
  -- Kein CHECK — shared:* ist freitext-suffix.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'HOT'
    CHECK (tier IN ('HOT', 'WARM', 'COLD'));

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS accessed_at TIMESTAMPTZ NULL;
  -- NULL = nie zugegriffen seit Migration; Phase 4 setzt Default = created_at beim ersten Read.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS decay_score REAL NOT NULL DEFAULT 1.0;

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS content_hash TEXT NULL;
  -- SHA-256 hex; wird von Phase 2 beim Write berechnet, Backfill via OB-80.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS manually_authored BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS task_status TEXT NULL
    CHECK (task_status IS NULL OR task_status IN ('open', 'done'));
  -- Nur relevant wenn entry_type='task'. NULL für memory/process.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS significance REAL NULL
    CHECK (significance IS NULL OR (significance >= 0.0 AND significance <= 1.0));
  -- Phase 2 (OB-71) füllt; NULL = nicht klassifiziert.

-- Indizes für Hot-Path-Queries der späteren Phasen.

CREATE INDEX IF NOT EXISTS idx_graph_nodes_tier_score
  ON graph_nodes (tier, decay_score DESC)
  WHERE type = 'Turn';

CREATE INDEX IF NOT EXISTS idx_graph_nodes_entry_type
  ON graph_nodes (entry_type)
  WHERE type = 'Turn';

CREATE INDEX IF NOT EXISTS idx_graph_nodes_content_hash
  ON graph_nodes (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_graph_nodes_visibility
  ON graph_nodes (visibility)
  WHERE type = 'Turn';

-- Partieller Index für offene Tasks (Phase 7 Process-Memory braucht das).
CREATE INDEX IF NOT EXISTS idx_graph_nodes_open_tasks
  ON graph_nodes (created_at DESC)
  WHERE entry_type = 'task' AND task_status = 'open';
