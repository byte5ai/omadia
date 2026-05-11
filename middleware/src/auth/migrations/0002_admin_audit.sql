-- OB-50 — admin audit log + platform-wide settings KV.
--
-- Two tables in one migration because both are infrastructure for the
-- admin-UI (provider toggle + user CRUD):
--
--   1. `admin_audit` records every privileged admin action (user
--      create/update/delete, provider enable/disable, password reset)
--      so an operator can answer "who disabled Entra last week?".
--      Schema is intentionally generic — `action` is a free-form verb,
--      `target` identifies the affected entity, `before`/`after` carry
--      JSON snapshots so we don't have to add new columns per action.
--
--   2. `platform_settings` is a tiny key→JSON KV used for runtime config
--      that survives a restart but isn't tied to a specific agent (the
--      per-agent vault is too narrow). For OB-50 it stores
--      `auth.active_providers` — the Day-2 subset of AUTH_PROVIDERS the
--      admin has currently enabled. The env-var stays the whitelist;
--      this row is the override.

CREATE TABLE IF NOT EXISTS admin_audit (
  id          UUID         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,                                       -- nullable: system actions (bootstrap)
  actor_email TEXT,                                       -- denormalised for human reading
  action      TEXT         NOT NULL,                      -- 'user.create' | 'user.update' | 'user.delete' | 'user.reset_password' | 'auth.provider_enable' | 'auth.provider_disable'
  target      TEXT         NOT NULL,                      -- entity ref: 'user:<uuid>' | 'provider:<id>'
  before      JSONB,                                      -- pre-state snapshot (NULL on create)
  after       JSONB,                                      -- post-state snapshot (NULL on delete)
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_created_idx
  ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx
  ON admin_audit (actor_id);
CREATE INDEX IF NOT EXISTS admin_audit_action_idx
  ON admin_audit (action);

CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT         NOT NULL PRIMARY KEY,
  value       JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
