/**
 * `agent_teams_installs` — the PERSISTED team↔agent bindings (migration 0051).
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * Before this store, "which teams is this agent installed in?" was answered by
 * reading `agent_teams_identities.team_id` — a single nullable column whose
 * documented job is resume evidence for the provisioning runner, i.e. the
 * TARGET of the last request. Deriving a binding list from it meant the list
 * could never hold more than one entry, a second team had to be refused rather
 * than recorded, and a re-target silently replaced the only thing resembling a
 * binding. The operator-visible symptom was exactly that: bindings that did not
 * persist.
 *
 * This table is the binding, keyed by `(agent_id, team_id)`. The identity row
 * keeps `team_id` for the job it was built for and stops being the read model.
 *
 * NAME CACHE, NOT NAME TRUTH. `teamDisplayName` is whatever Graph last said
 * (`teamsProvisioner@1.getTeam`, connector >= 0.5.0). Teams are renamed and
 * nothing notifies us, so the value is stored WITH its `displayNameSyncedAt`
 * timestamp and never treated as authoritative — it exists so the operator UI
 * shows a name instead of a GUID even when the connector is absent, too old or
 * briefly unreachable. `null` means "never resolved", which the UI renders as
 * the bare id rather than inventing a label.
 *
 * Every write is an UPSERT on the pair, so a re-run of the provisioning chain
 * (which is idempotent by design) converges instead of erroring.
 */

import type { Pool } from 'pg';

/** One persisted `(agent, team)` binding. */
export interface AgentTeamsInstallRecord {
  readonly agentId: string;
  readonly teamId: string;
  /** Catalog app id that was installed into THIS team. */
  readonly teamsAppId: string | null;
  /** Cached Graph display name — `null` until resolved once. */
  readonly teamDisplayName: string | null;
  /** When the cache above was last refreshed. `null` with a `null` name. */
  readonly displayNameSyncedAt: Date | null;
  readonly installedAt: Date;
  readonly updatedAt: Date;
}

export interface RecordAgentTeamsInstallInput {
  readonly agentId: string;
  readonly teamId: string;
  readonly teamsAppId?: string | null;
  /** Only written when provided — a re-record without a resolved name must
   *  not wipe a name resolved by an earlier run. */
  readonly teamDisplayName?: string | null;
}

const COLUMNS =
  'agent_id, team_id, teams_app_id, team_display_name, display_name_synced_at, installed_at, updated_at';

interface AgentTeamsInstallRow {
  agent_id: string;
  team_id: string;
  teams_app_id: string | null;
  team_display_name: string | null;
  display_name_synced_at: Date | null;
  installed_at: Date;
  updated_at: Date;
}

function mapRow(row: AgentTeamsInstallRow): AgentTeamsInstallRecord {
  return {
    agentId: row.agent_id,
    teamId: row.team_id,
    teamsAppId: row.teams_app_id,
    teamDisplayName: row.team_display_name,
    displayNameSyncedAt: row.display_name_synced_at,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export class AgentTeamsInstallStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Every binding of one agent, oldest install first — a stable order, so the
   * operator list does not reshuffle between reads.
   */
  async listForAgent(agentId: string): Promise<readonly AgentTeamsInstallRecord[]> {
    const res = await this.pool.query<AgentTeamsInstallRow>(
      `SELECT ${COLUMNS} FROM agent_teams_installs
        WHERE agent_id = $1
        ORDER BY installed_at ASC, team_id ASC`,
      [agentId],
    );
    return res.rows.map(mapRow);
  }

  /** One binding, or `undefined` when the agent is not installed there. */
  async get(
    agentId: string,
    teamId: string,
  ): Promise<AgentTeamsInstallRecord | undefined> {
    const res = await this.pool.query<AgentTeamsInstallRow>(
      `SELECT ${COLUMNS} FROM agent_teams_installs
        WHERE agent_id = $1 AND team_id = $2`,
      [agentId, teamId],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Record (or refresh) a binding. Called by the provisioning runner once
   * Graph has confirmed the install — never before, so the table only ever
   * describes installs that happened.
   *
   * `installed_at` is preserved on conflict: a re-run of an idempotent chain
   * re-asserts an install that already existed and must not restate when it
   * first happened.
   */
  async record(
    input: RecordAgentTeamsInstallInput,
  ): Promise<AgentTeamsInstallRecord> {
    const name = input.teamDisplayName ?? null;
    const res = await this.pool.query<AgentTeamsInstallRow>(
      `INSERT INTO agent_teams_installs
         (agent_id, team_id, teams_app_id, team_display_name, display_name_synced_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (agent_id, team_id) DO UPDATE SET
         teams_app_id = COALESCE(EXCLUDED.teams_app_id, agent_teams_installs.teams_app_id),
         team_display_name =
           COALESCE(EXCLUDED.team_display_name, agent_teams_installs.team_display_name),
         display_name_synced_at = CASE
           WHEN EXCLUDED.team_display_name IS NOT NULL THEN now()
           ELSE agent_teams_installs.display_name_synced_at
         END,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [input.agentId, input.teamId, input.teamsAppId ?? null, name],
    );
    const row = res.rows[0];
    if (row === undefined) {
      // Unreachable: INSERT … ON CONFLICT DO UPDATE always returns the row.
      throw new Error(
        `failed to record teams install for agent '${input.agentId}' team '${input.teamId}'`,
      );
    }
    return mapRow(row);
  }

  /**
   * Refresh only the cached name. Separate from {@link record} because the
   * name resolver runs on READ (opportunistically, best-effort) and must not
   * be able to create a binding that no install produced — hence UPDATE, not
   * upsert. Returns `false` when there was no such binding.
   */
  async setDisplayName(
    agentId: string,
    teamId: string,
    displayName: string,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE agent_teams_installs
          SET team_display_name = $3, display_name_synced_at = now(), updated_at = now()
        WHERE agent_id = $1 AND team_id = $2`,
      [agentId, teamId, displayName],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Drop one binding. `false` when it was already absent — the uninstall
   *  path treats that as success (`already-absent`), so it is a return value,
   *  not an error. */
  async remove(agentId: string, teamId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM agent_teams_installs WHERE agent_id = $1 AND team_id = $2`,
      [agentId, teamId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
