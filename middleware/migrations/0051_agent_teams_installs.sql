-- ── Agent factory: persisted team↔agent bindings ───────────────────────────
-- One row per (agent, team) the agent's Teams app is actually installed in.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Migration 0049 records a SINGLE nullable `team_id` on `agent_teams_identities`
-- and documents it as what it is: resume evidence for the provisioning runner,
-- i.e. the install TARGET of the last request. The operator read model
-- (`GET /v1/operator/agents/:slug/teams`) derived its list from that one
-- column, which made three things true that operators kept running into:
--
--   * only ONE binding could ever be shown, so an agent living in two teams
--     was misreported as living in the last one requested;
--   * a re-target request had to be REFUSED (409 `team_install_conflict`)
--     because accepting it would overwrite the only column there was — the
--     "no persistence of bindings" symptom: the binding was not stored, it
--     was merely the runner's scratch field;
--   * a Teams team was only ever addressable by its GUID, because there was
--     no row to cache its display name on.
--
-- So the binding gets its own table, keyed by the pair. The identity row keeps
-- `team_id` for exactly the job it was documented for (resume evidence for the
-- run in flight) and stops being the read model.
--
-- `team_display_name` — CACHE, NOT TRUTH
-- --------------------------------------
-- Graph owns the name; a team can be renamed at any time and nothing tells us.
-- It is stored so the operator UI can show "Marketing" instead of a GUID even
-- while the M365 connector is missing, too old (`getTeam` arrived in 0.5.0) or
-- momentarily unreachable, and `display_name_synced_at` records how stale that
-- answer is. NULL means "never resolved" — the UI then shows the id alone
-- rather than inventing a label.
--
-- ON DELETE CASCADE: a binding without its identity row is unreachable — the
-- app package, the bot and the catalog entry it addresses all hang off that
-- row. Deleting the identity is the documented way to unprovision an agent,
-- and the bindings go with it.
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS plus an
-- ON CONFLICT DO NOTHING backfill, so re-applying the file is a no-op (schema
-- CI double-applies every file in this series).
CREATE TABLE IF NOT EXISTS agent_teams_installs (
  agent_id               TEXT        NOT NULL
    REFERENCES agent_teams_identities (agent_id) ON DELETE CASCADE,
  team_id                TEXT        NOT NULL,
  -- Catalog id of the app that was installed into this team. Recorded per
  -- binding rather than read from the identity row: a re-uploaded catalog app
  -- changes the identity's id, and an uninstall must address the installation
  -- that actually exists in THAT team.
  teams_app_id           TEXT,
  -- Graph display name of the team, cached — see above.
  team_display_name      TEXT,
  display_name_synced_at TIMESTAMPTZ,
  installed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, team_id)
);

-- Backfill the single-column era: every identity that reached the terminal
-- `installed` state with a recorded team WAS a binding — it just had nowhere
-- to live. `installed_at` takes the row timestamp, which is the same evidence
-- the old read model published as the install time.
INSERT INTO agent_teams_installs (agent_id, team_id, teams_app_id, installed_at, updated_at)
SELECT agent_id, team_id, teams_app_id, updated_at, updated_at
  FROM agent_teams_identities
 WHERE state = 'installed'
   AND team_id IS NOT NULL
ON CONFLICT (agent_id, team_id) DO NOTHING;

-- rollback: DROP TABLE agent_teams_installs;
