-- ── Agent identity: what a DEPLOYED agent is called and looks like (#914) ───
-- One optional row per agent carrying the identity an operator authors on the
-- agent's own page: name, descriptions, behaviour text, accent colour
-- and an avatar. Provisioning reads it when it renders the agent's
-- Teams app package (`services/teamsAppPackageAssets.ts`), so two agents in
-- one tenant stop shipping the same name, the same synthesized description
-- and the same icon.
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `agents`
-- ---------------------------------------------
-- `ConfigStore.listAgents()` runs on every operator dashboard load and on
-- every registry rebuild. Three BYTEA columns on `agents` would ride along on
-- each of those reads for no reason. Splitting them off also keeps the
-- identity write path (this table, one writer:
-- `platform/agentIdentityStore.ts`) away from the registry's own row shape.
--
-- WHY EVERY TEXT COLUMN IS NULLABLE
-- ---------------------------------
-- NULL means "not authored — inherit". The store resolves an absent value
-- against `agents.name` / `agents.description`, so an agent that predates this
-- table behaves exactly as before and an operator can clear a single field
-- back to the inherited value instead of being forced to invent one.
--
-- `revision` IS THE TEAMS PACKAGE VERSION
-- ---------------------------------------
-- Teams refuses a catalog update whose manifest `version` did not increase.
-- Every identity write bumps this counter and the package renders its
-- manifest as `1.0.<revision>`, which makes "edit the identity, re-publish"
-- work without a second version column somewhere else. Monotonic per agent;
-- it is a version counter, not a row count.
--
-- NO EXTERNAL STORAGE FOR THE AVATAR. The PNGs are small (a 192×192 and a
-- 32×32 icon plus the original upload, capped at 2 MB by the route) and they
-- are read exactly once per provisioning run, so a bytea column beats adding
-- a blob store to the deployment contract. `avatar_etag` is the SHA-256 of
-- the ORIGINAL upload — it lets the UI cache the preview and lets a caller
-- tell "same picture, re-uploaded" from "new picture".
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS is a no-op on
-- re-apply (schema CI double-applies every file in this series).
CREATE TABLE IF NOT EXISTS agent_identities (
  agent_id          UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  display_name      TEXT,
  short_description TEXT,
  long_description  TEXT,
  instructions      TEXT,
  accent_color      TEXT,
  avatar_png        BYTEA,
  icon_color_png    BYTEA,
  icon_outline_png  BYTEA,
  avatar_etag       TEXT,
  revision          INT         NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id)
);

-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS and this file must be
-- applicable twice (schema CI gate). The accent colour is written into a
-- Teams manifest, which accepts `#RRGGBB` and nothing else; rejecting it here
-- keeps a hand-written row from producing a package Teams would refuse.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_accent_color_check'
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_accent_color_check
      CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_revision_check'
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_revision_check
      CHECK (revision >= 1);
  END IF;
END
$$;

COMMENT ON TABLE agent_identities IS
  'Per-agent identity (#914): name, descriptions, behaviour text, accent colour, avatar. Authored on the operator agent page, consumed by Teams provisioning. NULL text column = inherit from agents.';
COMMENT ON COLUMN agent_identities.revision IS
  'Monotonic identity revision. Rendered as the Teams manifest version 1.0.<revision> so an edited identity can be re-published.';

-- rollback: DROP TABLE agent_identities;
