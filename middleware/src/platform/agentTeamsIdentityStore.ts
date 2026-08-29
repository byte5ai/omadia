/**
 * `agent_teams_identities` store (epic byte5ai/omadia#860, wave W1a) —
 * backing migration 0049. Sibling of `pluginSqlGrantStore.ts` (0047) and
 * `publicPathGrantStore.ts` (0046) in shape, with one deliberate posture
 * difference: those stores are fail-closed on read because an unread row
 * removes a PERMISSION; here a missing row simply means "no Teams identity
 * provisioned yet", so query failures SURFACE to the caller instead of
 * masquerading as a fresh 'pending' identity. A 500 the operator can see is
 * strictly better than a status endpoint inventing provisioning state.
 *
 * SINGLE WRITER RULE. `state` and `last_error` are written exclusively
 * through this store: the provisioning job runner
 * (`services/teamsProvisioningJob.ts`) drives the chain
 * pending → app_registered → bot_created → package_built → catalog_uploaded
 * → installed (terminal: failed) and the exported
 * {@link TEAMS_PROVISIONING_STATES} union is the SINGLE vocabulary — its
 * values mirror the CHECK constraint of migration 0049 exactly, and both the
 * runner and the operator router import it from here.
 *
 * NO SECRET MATERIAL. The row carries only app_id / tenant_id /
 * teams_app_id / teams_app_external_id — the bot's client secret stays in
 * the M365 connector's vault (opaque ref `teams_bot_password:<appId>`,
 * derived from `app_id` by the status projection, never stored).
 *
 * ONE IDENTITY PER AGENT, ONE AGENT PER BOT SLUG. `ensureForAgent` is the
 * create-if-absent gate on the `agent_id` primary key; the `bot_slug` UNIQUE
 * constraint makes a cross-agent slug collision fail loudly as
 * {@link BotSlugTakenError} (409 upstream) instead of letting two agents
 * share one bot identity and credential namespace.
 */

import type { Pool } from 'pg';

import type { TeamsTargetKind } from './teamsInstallTarget.js';

// ---------------------------------------------------------------------------
// State vocabulary — the CHECK constraint of migration 0049, verbatim.
// ---------------------------------------------------------------------------

export const TEAMS_PROVISIONING_STATES = [
  'pending',
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
  'failed',
] as const;

export type TeamsProvisioningState = (typeof TEAMS_PROVISIONING_STATES)[number];

export function isTeamsProvisioningState(
  value: unknown,
): value is TeamsProvisioningState {
  return (
    typeof value === 'string' &&
    (TEAMS_PROVISIONING_STATES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Records + errors
// ---------------------------------------------------------------------------

/** One `agent_teams_identities` row, camelCase. */
export interface AgentTeamsIdentityRecord {
  readonly agentId: string;
  readonly botSlug: string;
  readonly displayName: string;
  readonly state: TeamsProvisioningState;
  /** Install target of the last provisioning request — resume evidence. */
  readonly teamId: string | null;
  /**
   * WHICH KIND of target {@link teamId} addresses (migration 0054): a team, a
   * group chat or a 1:1 chat. Resume evidence too — a run that picks up an
   * interrupted chain must call the Graph endpoint the request asked for, and
   * a bare 32-hex id cannot be classified back into one afterwards.
   */
  readonly targetKind: TeamsTargetKind;
  readonly appId: string | null;
  /**
   * The Entra application's DIRECTORY OBJECT id (migration 0055) — a
   * different identifier from {@link appId}, and the only one the
   * recycle-bin purge accepts.
   *
   * `null` on rows provisioned before migration 0055 and on rows whose
   * registration does not exist yet. See the migration on why it is stored
   * rather than looked up: after `DELETE /applications/{id}` the application
   * is gone from `/applications`, so the appId → objectId lookup that would
   * have produced it no longer works — and without it the deleted app sits
   * in the recycle bin holding this agent's `uniqueName` for 30 days.
   */
  readonly appObjectId: string | null;
  readonly tenantId: string | null;
  readonly teamsAppId: string | null;
  readonly teamsAppExternalId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnsureAgentTeamsIdentityInput {
  readonly agentId: string;
  readonly botSlug: string;
  readonly displayName: string;
  /** When provided, recorded as the (new) install target — the ONLY field an
   *  ensure updates on an existing row; bot_slug/display_name stay as
   *  created (one identity per agent). */
  readonly teamId?: string;
  /** Kind of the target above. Defaults to `'team'`, which is what every
   *  request before migration 0054 meant. */
  readonly targetKind?: TeamsTargetKind;
}

export interface AgentTeamsIdentityUpdate {
  readonly state?: TeamsProvisioningState;
  /** `null` clears the recorded install target — what an uninstall leaves
   *  behind (byte5ai/omadia#900). The column is nullable (migration 0049). */
  readonly teamId?: string | null;
  /** Set together with {@link teamId} when a request re-targets the row. */
  readonly targetKind?: TeamsTargetKind;
  /**
   * The four Azure identifiers accept `null` as well as a value: the
   * provisioning chain only ever writes them, but a teardown
   * (`services/teamsIdentityReset.ts`) has to CLEAR them, and a row that
   * kept pointing at a purged app registration would send the next run
   * looking for something that is not there any more.
   */
  readonly appId?: string | null;
  readonly appObjectId?: string | null;
  readonly tenantId?: string | null;
  readonly teamsAppId?: string | null;
  readonly teamsAppExternalId?: string | null;
  /** `null` clears a previous error. */
  readonly lastError?: string | null;
}

/** The requested bot slug is already held by ANOTHER agent's identity. */
export class BotSlugTakenError extends Error {
  public readonly code = 'bot_slug_taken';
  public readonly botSlug: string;

  constructor(botSlug: string) {
    super(
      `bot_slug_taken: bot slug '${botSlug}' is already used by another agent's Teams identity — bot slugs are globally unique (they name the Azure bot and its messaging endpoint)`,
    );
    this.name = 'BotSlugTakenError';
    this.botSlug = botSlug;
  }
}

/** An update addressed an agent that has no identity row. */
export class AgentTeamsIdentityNotFoundError extends Error {
  public readonly code = 'teams_identity_not_found';

  constructor(agentId: string) {
    super(`no agent_teams_identities row for agent '${agentId}'`);
    this.name = 'AgentTeamsIdentityNotFoundError';
  }
}

/** A write carried a state outside the CHECK-constraint vocabulary. Caught
 *  here (not by the DB) so the error names the union, and so no partial SET
 *  clause is ever sent. */
export class AgentTeamsIdentityStateError extends Error {
  public readonly code = 'invalid_teams_provisioning_state';

  constructor(value: unknown) {
    super(
      `invalid teams provisioning state ${JSON.stringify(value)} — expected one of ${TEAMS_PROVISIONING_STATES.join(', ')}`,
    );
    this.name = 'AgentTeamsIdentityStateError';
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const COLUMNS =
  'agent_id, bot_slug, display_name, state, team_id, target_kind, app_id, app_object_id, tenant_id, teams_app_id, teams_app_external_id, last_error, created_at, updated_at';

interface AgentTeamsIdentityRow {
  agent_id: string;
  bot_slug: string;
  display_name: string;
  state: string;
  team_id: string | null;
  target_kind: TeamsTargetKind;
  app_id: string | null;
  app_object_id: string | null;
  tenant_id: string | null;
  teams_app_id: string | null;
  teams_app_external_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: AgentTeamsIdentityRow): AgentTeamsIdentityRecord {
  if (!isTeamsProvisioningState(row.state)) {
    // Unreachable while the CHECK constraint stands; surfacing beats lying.
    throw new AgentTeamsIdentityStateError(row.state);
  }
  return {
    agentId: row.agent_id,
    botSlug: row.bot_slug,
    displayName: row.display_name,
    state: row.state,
    teamId: row.team_id,
    targetKind: row.target_kind,
    appId: row.app_id,
    appObjectId: row.app_object_id,
    tenantId: row.tenant_id,
    teamsAppId: row.teams_app_id,
    teamsAppExternalId: row.teams_app_external_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === constraint;
}

/** Postgres' default name for the migration's `UNIQUE (bot_slug)`. */
const BOT_SLUG_UNIQUE_CONSTRAINT = 'agent_teams_identities_bot_slug_key';

export class AgentTeamsIdentityStore {
  constructor(private readonly pool: Pool) {}

  /** `undefined` = no identity (not provisioned). Query failures surface. */
  async getByAgentId(
    agentId: string,
  ): Promise<AgentTeamsIdentityRecord | undefined> {
    const res = await this.pool.query<AgentTeamsIdentityRow>(
      `SELECT ${COLUMNS} FROM agent_teams_identities WHERE agent_id = $1`,
      [agentId],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Create-if-absent (the one-identity-per-agent gate). An existing row is
   * returned with only `team_id` refreshed (a re-POST may target a new
   * team); its bot_slug/display_name are NOT touched. A bot_slug held by a
   * DIFFERENT agent throws {@link BotSlugTakenError}.
   */
  async ensureForAgent(
    input: EnsureAgentTeamsIdentityInput,
  ): Promise<AgentTeamsIdentityRecord> {
    try {
      const res = await this.pool.query<AgentTeamsIdentityRow>(
        `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, team_id, target_kind)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_id) DO UPDATE SET
           team_id     = COALESCE(EXCLUDED.team_id, agent_teams_identities.team_id),
           -- Moves WITH the id: a re-target that changed the kind must not
           -- leave the row claiming the previous endpoint.
           target_kind = CASE
             WHEN EXCLUDED.team_id IS NULL THEN agent_teams_identities.target_kind
             ELSE EXCLUDED.target_kind
           END,
           updated_at = now()
         RETURNING ${COLUMNS}`,
        [
          input.agentId,
          input.botSlug,
          input.displayName,
          input.teamId ?? null,
          input.targetKind ?? 'team',
        ],
      );
      const row = res.rows[0];
      if (row === undefined) {
        // Unreachable: INSERT … ON CONFLICT DO UPDATE always returns the row.
        throw new AgentTeamsIdentityNotFoundError(input.agentId);
      }
      return mapRow(row);
    } catch (err) {
      if (isUniqueViolationOn(err, BOT_SLUG_UNIQUE_CONSTRAINT)) {
        throw new BotSlugTakenError(input.botSlug);
      }
      throw err;
    }
  }

  /**
   * Patch one row (the job runner's exclusive write path for state /
   * last_error / step evidence). Throws
   * {@link AgentTeamsIdentityNotFoundError} for an unknown agent and
   * {@link AgentTeamsIdentityStateError} for a state outside the union —
   * never a silent no-op.
   */
  async update(
    agentId: string,
    patch: AgentTeamsIdentityUpdate,
  ): Promise<AgentTeamsIdentityRecord> {
    const sets: string[] = [];
    const values: unknown[] = [agentId];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.state !== undefined) {
      if (!isTeamsProvisioningState(patch.state)) {
        throw new AgentTeamsIdentityStateError(patch.state);
      }
      add('state', patch.state);
    }
    if (patch.teamId !== undefined) add('team_id', patch.teamId);
    if (patch.targetKind !== undefined) add('target_kind', patch.targetKind);
    if (patch.appId !== undefined) add('app_id', patch.appId);
    if (patch.appObjectId !== undefined) add('app_object_id', patch.appObjectId);
    if (patch.tenantId !== undefined) add('tenant_id', patch.tenantId);
    if (patch.teamsAppId !== undefined) add('teams_app_id', patch.teamsAppId);
    if (patch.teamsAppExternalId !== undefined) {
      add('teams_app_external_id', patch.teamsAppExternalId);
    }
    if (patch.lastError !== undefined) add('last_error', patch.lastError);
    sets.push('updated_at = now()');
    const res = await this.pool.query<AgentTeamsIdentityRow>(
      `UPDATE agent_teams_identities SET ${sets.join(', ')} WHERE agent_id = $1 RETURNING ${COLUMNS}`,
      values,
    );
    const row = res.rows[0];
    if (row === undefined) throw new AgentTeamsIdentityNotFoundError(agentId);
    return mapRow(row);
  }

  /**
   * Forget the recorded team install after the connector removed the app
   * from the team (byte5ai/omadia#900).
   *
   * The row drops back to `catalog_uploaded`, NOT to `pending`: the Entra
   * app, the Azure bot and the tenant catalog entry all still exist and are
   * still this agent's — only the team install is gone. That is exactly the
   * state a fresh `POST /:slug/teams` resumes from, so re-installing later
   * costs one Graph call instead of re-running the whole chain.
   *
   * `lastError` is cleared with it: whatever failed before, the operator has
   * just successfully driven the row to a clean state.
   */
  async clearTeamInstall(agentId: string): Promise<AgentTeamsIdentityRecord> {
    return this.update(agentId, {
      state: 'catalog_uploaded',
      teamId: null,
      targetKind: 'team',
      lastError: null,
    });
  }

  /**
   * Return the row to the position it held before anything was provisioned —
   * the last act of a teardown (`services/teamsIdentityReset.ts`).
   *
   * A RESET, NOT A ROW DELETION. `bot_slug` and `display_name` are the only
   * two fields in this row a human typed; every other one is an identifier
   * Azure handed back. Dropping the row would throw the operator's two
   * answers away and make them retype both to try again — and because
   * `bot_slug` is `UNIQUE`, dropping it also silently changes what a
   * re-create is allowed to be called. Keeping them means the retry is one
   * button, with the same slug, which is the whole reason someone asked for
   * this in the first place.
   *
   * `state` goes to `'pending'` rather than to some intermediate rank because
   * by the time this runs the Entra app, the Azure bot and the catalog entry
   * are all provably gone — the caller does not reach this step otherwise.
   * That is exactly the difference from {@link clearTeamInstall}, which stops
   * at `'catalog_uploaded'` precisely because those three still exist.
   *
   * The Azure identifiers are NULLed for the same reason: a row that kept a
   * purged `app_id` would let the chain's evidence guards skip step 1 and
   * then build a bot on an application that is not there any more.
   *
   * ON THE ORDER OF WRITES. This is the LAST thing a teardown does, never the
   * first. `app_object_id` is what makes an interrupted purge resumable, so
   * clearing it before the purge landed would destroy the only pointer to the
   * tombstone holding this agent's `uniqueName`.
   */
  async resetForRetry(agentId: string): Promise<AgentTeamsIdentityRecord> {
    return this.update(agentId, {
      state: 'pending',
      teamId: null,
      targetKind: 'team',
      appId: null,
      appObjectId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
    });
  }

  /** Persist an enqueue failure so the status endpoint can show WHY nothing
   *  is running (the POST handler calls this best-effort from its
   *  fire-and-forget catch). State is deliberately untouched. */
  async recordEnqueueFailure(agentId: string, message: string): Promise<void> {
    await this.update(agentId, { lastError: `enqueue_failed: ${message}` });
  }

  /**
   * Rows a boot-time resume should re-enqueue: provisioning started (a team
   * target is recorded) but neither completed nor terminally failed.
   * 'failed' is deliberately excluded — it stays parked until an operator
   * re-POSTs.
   */
  async listResumable(): Promise<readonly AgentTeamsIdentityRecord[]> {
    const res = await this.pool.query<AgentTeamsIdentityRow>(
      `SELECT ${COLUMNS} FROM agent_teams_identities
       WHERE state NOT IN ('installed', 'failed') AND team_id IS NOT NULL
       ORDER BY created_at ASC`,
    );
    return res.rows.map(mapRow);
  }
}
