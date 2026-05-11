-- Palaia-Integration · Phase 5 (OB-74): per-Agent Block/Boost-Tabelle für den
-- Token-Budget-Assembler. Tenant-scoped, primary key (tenant, agent, entry).
--
-- Lookup-Pfad: ContextRetriever.assembleForBudget bulk-lädt einmal pro Turn
-- alle (block | boost)-Einträge für den anfragenden Agent (`loadForAgent`),
-- dann inline-Filter/Multiplier auf der bereits-scorten Hit-Liste — kein
-- N+1 SQL pro Hit.
--
-- Kein FK auf graph_nodes(external_id): Turns können durch GC verschwinden;
-- orphan rows werden später via Cleanup-Cron geräumt (Slice B optional).

CREATE TABLE IF NOT EXISTS agent_priorities (
  tenant_id          TEXT      NOT NULL,
  agent_id           TEXT      NOT NULL,
  entry_external_id  TEXT      NOT NULL,
  action             TEXT      NOT NULL CHECK (action IN ('block', 'boost')),
  weight             REAL      NOT NULL DEFAULT 1.3,
  reason             TEXT      NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, agent_id, entry_external_id)
);

-- Hot-Path: Resolver-Lookup `loadForAgent` filtert WHERE tenant_id=$1 AND agent_id=$2.
CREATE INDEX IF NOT EXISTS idx_agent_priorities_agent
  ON agent_priorities (tenant_id, agent_id, action);

-- Wartungspfad: Cleanup-Cron findet orphans pro entry_external_id.
CREATE INDEX IF NOT EXISTS idx_agent_priorities_entry
  ON agent_priorities (tenant_id, entry_external_id);
