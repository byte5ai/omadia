-- Palaia-Integration · Phase 7 (OB-76): Process-Memory.
--
-- Eigenständige Tabelle für strukturierte Workflows mit Versioning +
-- Embedding für Dedup-First-Write + Hybrid-Retrieval.
--
-- Architektur-Decision (siehe HANDOFF-2026-05-08-palaia-phase-7): Variante A
-- (eigene Tabelle statt Marker-Hack auf graph_nodes). Process ist konzeptuell
-- ein eigenständiges Entity (title, steps, version), nicht eine Turn-Variante.
--
-- HARD-INVARIANTS:
-- 1. `id` ist deterministisch: 'process:<scope>:<slugify(title)>'. Edits
--    ändern keine IDs (slug aus title, NICHT version-bezogen).
-- 2. Naming-Convention server-side enforced via CHECK + Tool-Zod-Regex:
--    `^[A-Z][^:]+: .+` (z.B. "Backend: Deploy to staging").
-- 3. History append-only — kein DELETE auf process_history. Row-Compaction
--    via späterer GC (Phase 7.5).
-- 4. Tenant-scoped via Composite-PK (tenant_id, id).

CREATE TABLE IF NOT EXISTS processes (
  id              TEXT      NOT NULL,
  tenant_id       TEXT      NOT NULL,
  scope           TEXT      NOT NULL,
  title           TEXT      NOT NULL CHECK (title ~ '^[A-Z][^:]+: .+'),
  steps           JSONB     NOT NULL,
  visibility      TEXT      NOT NULL DEFAULT 'team',
  embedding       vector(768) NULL,
  version         INTEGER   NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

-- Browse-Pfad: Operator-UI listet Processes pro Scope.
CREATE INDEX IF NOT EXISTS idx_processes_scope
  ON processes (tenant_id, scope);

-- Dedup-First-Write Hot-Path: cosine-similarity vor INSERT.
CREATE INDEX IF NOT EXISTS idx_processes_embedding
  ON processes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  WHERE embedding IS NOT NULL;

-- query_processes Hybrid-Retrieval: BM25 auf title + flattened steps.
CREATE INDEX IF NOT EXISTS idx_processes_fts
  ON processes USING gin (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(steps::text, ''))
  );

-- Versioning-Append-Only. Snapshot des alten Zustands BEFORE UPDATE auf
-- processes. version-Spalte ist monoton steigend pro id.
CREATE TABLE IF NOT EXISTS process_history (
  id              TEXT      NOT NULL,
  tenant_id       TEXT      NOT NULL,
  version         INTEGER   NOT NULL,
  title           TEXT      NOT NULL,
  steps           JSONB     NOT NULL,
  visibility      TEXT      NOT NULL,
  superseded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id, version)
);

-- Hot-Path: history(id) DESC für ProcessMemoryService.history(id).
CREATE INDEX IF NOT EXISTS idx_process_history_id
  ON process_history (tenant_id, id, version DESC);
