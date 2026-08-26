-- ── Agent factory: per-agent Teams identities (epic #860, wave W1a) ─────────
-- One row per agent that has (or is getting) a provisioned Microsoft Teams
-- identity: Entra app registration → Azure bot → Teams app package → tenant
-- catalog upload → team install. The provisioning job runner
-- (`src/services/teamsProvisioningJob.ts`) walks `state` through the chain
-- and persists step evidence into the columns below so a resume re-enters
-- exactly where the last run stopped; the operator endpoints
-- (`src/routes/operatorAgents.ts`, POST/GET /:slug/teams-identity) create and
-- project these rows through `src/platform/agentTeamsIdentityStore.ts`.
--
-- WHY BOTH KEYS ARE UNIQUE
-- ------------------------
-- `PRIMARY KEY (agent_id)` — conservative one-identity-per-agent rule of this
-- wave; `ensureForAgent` leans on it for its create-if-absent semantics.
--
-- `UNIQUE (bot_slug)` — the slug is the bot's ARM handle, the path segment of
-- the per-bot messaging endpoint (`/api/teams/<botSlug>/messages`,
-- channel-teams >= 0.20.0) AND the key channel-teams derives per-bot secret
-- names from. Two agents sharing a slug would share a bot identity and
-- overwrite each other's credentials, so the collision fails loudly here
-- instead of silently at provisioning time.
--
-- NO SECRET COLUMN — DELIBERATE
-- -----------------------------
-- The bot's client secret never reaches this table (or the middleware at
-- all): the M365 connector's `createAppRegistration` keeps the generated
-- password in the CONNECTOR's vault and only the opaque reference
-- (`teams_bot_password:<app_id>`) crosses the service boundary. The status
-- endpoint derives that ref from `app_id`; nothing stores it.
--
-- `team_id` records the install target so boot-time resume can re-enqueue
-- interrupted provisioning runs (the team is a runner input, not derivable
-- from the other columns). Nullable: a row created before the first
-- provisioning request carries none.
--
-- Idempotent by construction: the single CREATE TABLE IF NOT EXISTS is a
-- no-op on re-apply (schema CI double-applies every file in this series).
CREATE TABLE IF NOT EXISTS agent_teams_identities (
  agent_id              TEXT        NOT NULL,
  bot_slug              TEXT        NOT NULL,
  display_name          TEXT        NOT NULL,
  state                 TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT agent_teams_identities_state_check CHECK (state IN (
      'pending',
      'app_registered',
      'bot_created',
      'package_built',
      'catalog_uploaded',
      'installed',
      'failed'
    )),
  team_id               TEXT,
  app_id                TEXT,
  tenant_id             TEXT,
  teams_app_id          TEXT,
  teams_app_external_id TEXT,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id),
  UNIQUE (bot_slug)
);

-- rollback: DROP TABLE agent_teams_identities;
