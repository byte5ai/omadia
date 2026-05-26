BEGIN;

-- Slice 3 — ACL on MemorableKnowledge nodes.
-- `acl_owners` is already a JSONB property on MemorableKnowledge rows
-- (Slice 2 default `[]`). This migration adds:
--   1. A GIN index on `properties->'acl_owners'` so owner-filter
--      queries hit an index instead of scanning every MK.
--   2. An append-only audit-log table `memory_acl_audit` covering
--      every owner-set mutation + delete. No FK on graph_nodes — the
--      trail must survive a memory delete (compliance).

CREATE INDEX IF NOT EXISTS idx_memorable_acl_owners
  ON graph_nodes USING gin ((properties->'acl_owners'))
  WHERE type = 'MemorableKnowledge';

CREATE TABLE IF NOT EXISTS memory_acl_audit (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   TEXT NOT NULL,
  -- 'mk:<uuid>' external_id form. No FK so the row outlives a delete.
  memory_external_id          TEXT NOT NULL,
  actor_omadia_user_id        UUID NOT NULL,
  actor_channel_identity_id   TEXT,
  action                      TEXT NOT NULL,
  before_owners               JSONB NOT NULL,
  -- NULL on 'delete' (no "after" state exists once the MK is gone).
  after_owners                JSONB,
  reason                      TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_acl_audit_action_chk CHECK (
    action IN ('create', 'expand', 'shrink', 'delete')
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_acl_audit_memory
  ON memory_acl_audit (tenant_id, memory_external_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_acl_audit_actor
  ON memory_acl_audit (tenant_id, actor_omadia_user_id, created_at DESC);

COMMIT;
