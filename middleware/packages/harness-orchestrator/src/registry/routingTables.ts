/**
 * #2055 — the management layer's routing tables (migrations 0081–0083):
 * default-agent entries, per-user selections and availability principals.
 *
 * All three are read WITH the rows of deleted agents (tombstones): an entry or
 * a selection that points to a deleted agent keeps pointing there and yields
 * "<name> was deleted", never another agent (spec 2042 §5.10, criterion 39).
 */

import type { Pool } from 'pg';

/** One default-agent entry. `agentId: null` is `off`. */
export interface DefaultAgentEntryRow {
  readonly id: string;
  /** `user:<id>`, or null for every user. */
  readonly principal: string | null;
  /** A channel type, or null for every channel. */
  readonly channelType: string | null;
  readonly agentId: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

/** A user's stored agent choice in one conversation. */
export interface AgentSelectionRow {
  readonly channelType: string;
  readonly conversationKey: string;
  /** `user:<id>`. */
  readonly principal: string;
  readonly agentId: string;
  readonly selectedAt: Date;
}

/** A named person (`user:<id>`) or group (`role:<key>`) an agent is available to. */
export interface AvailabilityPrincipalRow {
  readonly agentId: string;
  readonly principal: string;
}

export interface DefaultAgentEntryInput {
  readonly principal: string | null;
  readonly channelType: string | null;
  readonly agentId: string | null;
  readonly updatedBy?: string | null;
}

interface DefaultEntryDbRow {
  id: string;
  principal: string | null;
  channel_type: string | null;
  agent_id: string | null;
  updated_by: string | null;
  updated_at: Date;
}

interface SelectionDbRow {
  channel_type: string;
  conversation_key: string;
  principal: string;
  agent_id: string;
  selected_at: Date;
}

const UNDEFINED_TABLE = '42P01';

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

function mapDefaultEntry(row: DefaultEntryDbRow): DefaultAgentEntryRow {
  return {
    id: row.id,
    principal: row.principal,
    channelType: row.channel_type,
    agentId: row.agent_id,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function mapSelection(row: SelectionDbRow): AgentSelectionRow {
  return {
    channelType: row.channel_type,
    conversationKey: row.conversation_key,
    principal: row.principal,
    agentId: row.agent_id,
    selectedAt: row.selected_at,
  };
}

export class RoutingTables {
  constructor(private readonly pool: Pool) {}

  /** Every entry, deleted agents' included (tombstones keep their place). */
  async listDefaultEntries(): Promise<readonly DefaultAgentEntryRow[]> {
    try {
      const { rows } = await this.pool.query<DefaultEntryDbRow>(
        `SELECT id, principal, channel_type, agent_id, updated_by, updated_at
           FROM agent_default_entries
          ORDER BY principal NULLS LAST, channel_type NULLS LAST`,
      );
      return rows.map(mapDefaultEntry);
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  /** Creates or replaces the entry for exactly this (principal, channel) scope. */
  async upsertDefaultEntry(input: DefaultAgentEntryInput): Promise<DefaultAgentEntryRow> {
    const { rows } = await this.pool.query<DefaultEntryDbRow>(
      `INSERT INTO agent_default_entries (principal, channel_type, agent_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (COALESCE(principal, ''), COALESCE(channel_type, ''))
       DO UPDATE SET agent_id = EXCLUDED.agent_id,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()
       RETURNING id, principal, channel_type, agent_id, updated_by, updated_at`,
      [input.principal, input.channelType, input.agentId, input.updatedBy ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('upsertDefaultEntry: RETURNING produced no row');
    return mapDefaultEntry(row);
  }

  /** Removes one entry. The instance entry cannot be removed, only set to `off`. */
  async deleteDefaultEntry(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_default_entries
        WHERE id = $1 AND NOT (principal IS NULL AND channel_type IS NULL)`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async listSelections(): Promise<readonly AgentSelectionRow[]> {
    try {
      const { rows } = await this.pool.query<SelectionDbRow>(
        `SELECT channel_type, conversation_key, principal, agent_id, selected_at
           FROM agent_selections`,
      );
      return rows.map(mapSelection);
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  async setSelection(input: Omit<AgentSelectionRow, 'selectedAt'>): Promise<AgentSelectionRow> {
    const { rows } = await this.pool.query<SelectionDbRow>(
      `INSERT INTO agent_selections (channel_type, conversation_key, principal, agent_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_type, conversation_key, principal)
       DO UPDATE SET agent_id = EXCLUDED.agent_id, selected_at = now()
       RETURNING channel_type, conversation_key, principal, agent_id, selected_at`,
      [input.channelType, input.conversationKey, input.principal, input.agentId],
    );
    const row = rows[0];
    if (!row) throw new Error('setSelection: RETURNING produced no row');
    return mapSelection(row);
  }

  async clearSelection(channelType: string, conversationKey: string, principal: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM agent_selections
        WHERE channel_type = $1 AND conversation_key = $2 AND principal = $3`,
      [channelType, conversationKey, principal],
    );
  }

  async listAvailabilityPrincipals(): Promise<readonly AvailabilityPrincipalRow[]> {
    try {
      const { rows } = await this.pool.query<{ agent_id: string; principal: string }>(
        `SELECT agent_id, principal FROM agent_availability_principals ORDER BY agent_id, principal`,
      );
      return rows.map((r) => ({ agentId: r.agent_id, principal: r.principal }));
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  /**
   * Replaces an agent's availability in one transaction: everyone or not, the
   * channels (null = all) and the named people and groups.
   */
  async setAvailability(
    agentId: string,
    availability: {
      readonly everyone: boolean;
      readonly channels: readonly string[] | null;
      readonly principals: readonly string[];
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE agents SET available_to_everyone = $2, available_channels = $3, updated_at = now()
          WHERE id = $1`,
        [agentId, availability.everyone, availability.channels],
      );
      await client.query('DELETE FROM agent_availability_principals WHERE agent_id = $1', [agentId]);
      for (const principal of new Set(availability.principals)) {
        await client.query(
          'INSERT INTO agent_availability_principals (agent_id, principal) VALUES ($1, $2)',
          [agentId, principal],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
