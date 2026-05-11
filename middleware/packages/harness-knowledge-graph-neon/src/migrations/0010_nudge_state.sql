-- Palaia-Integration · Phase 8 (OB-77): Nudge-Pipeline.
--
-- Eigene Tabellen für Nudge-Lifecycle (success_streak, suppressed_until,
-- retired_at) + append-only Emissions-Audit. Lifecycle-Felder sind als
-- echte Spalten queryable (Operator-Dashboard, Curate-Cron OB-79), nicht
-- in graph_nodes.properties JSONB versteckt.
--
-- Architektur-Decision (siehe HANDOFF-2026-05-08-palaia-phase-8): Variante A
-- (eigene Tabellen statt graph_nodes-Marker). Nudge-State ist Coaching-State,
-- nicht Wissen — gehört nicht in den Knowledge-Graph.
--
-- HARD-INVARIANTS:
-- 1. Tenant-scoped via Composite-PK (tenant_id, agent_id, nudge_id).
--    Alle SELECT/UPDATE filtern WHERE tenant_id = $1.
-- 2. nudge_emissions ist append-only — kein DELETE. Cleanup via Curate-Cron
--    (OB-79) mit retention-window.
-- 3. workflow_hash auf emissions ist forensisch (nicht state-bestimmend).
--    Retire-Logik nutzt success_streak global pro (agent, nudge_id);
--    per-workflow-Schutz erfolgt trigger-side via alreadyPromoted-Check.

CREATE TABLE IF NOT EXISTS nudge_state (
  tenant_id         TEXT      NOT NULL,
  agent_id          TEXT      NOT NULL,
  nudge_id          TEXT      NOT NULL,
  success_streak    INTEGER   NOT NULL DEFAULT 0,
  regression_count  INTEGER   NOT NULL DEFAULT 0,
  suppressed_until  TIMESTAMPTZ NULL,
  retired_at        TIMESTAMPTZ NULL,
  last_emitted_at   TIMESTAMPTZ NULL,
  last_followed_at  TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, agent_id, nudge_id)
);

-- Append-only emission audit. Operator-Dashboard + success-signal-Detection.
CREATE TABLE IF NOT EXISTS nudge_emissions (
  id              BIGSERIAL   PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  agent_id        TEXT        NOT NULL,
  nudge_id        TEXT        NOT NULL,
  turn_id         TEXT        NOT NULL,
  tool_name       TEXT        NOT NULL,
  workflow_hash   TEXT        NULL,
  hint_text          TEXT        NOT NULL,
  cta_json           JSONB       NULL,
  success_signal_json JSONB      NULL,
  emitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  followed_at        TIMESTAMPTZ NULL,
  follow_turn_id     TEXT        NULL,
  regression_at      TIMESTAMPTZ NULL
);

-- Operator-Dashboard: emissions per agent, neueste zuerst.
CREATE INDEX IF NOT EXISTS idx_nudge_emissions_tenant_agent
  ON nudge_emissions (tenant_id, agent_id, emitted_at DESC);

-- Hot-Path: success-signal-Detection sucht "open" emissions (noch nicht
-- gefolgt, noch nicht regressiert) im withinTurns-Fenster.
CREATE INDEX IF NOT EXISTS idx_nudge_emissions_unfollowed
  ON nudge_emissions (tenant_id, agent_id, nudge_id, emitted_at DESC)
  WHERE followed_at IS NULL AND regression_at IS NULL;
