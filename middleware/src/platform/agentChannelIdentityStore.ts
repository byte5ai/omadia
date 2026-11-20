// An agent's own bot on a channel other than Teams (spec 2042 §5.3,
// migration 0105). Routing reads the same rows through
// `ConfigStore.listChannelIdentities`; this store is the operator's write
// side. No credential ever reaches it.

import type { Pool } from 'pg';

export interface AgentChannelIdentityRecord {
  readonly agentId: string;
  readonly channelType: string;
  readonly channelKey: string;
  readonly displayName: string | null;
  readonly externalRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentChannelIdentityInput {
  readonly agentId: string;
  readonly channelType: string;
  readonly channelKey: string;
  readonly displayName?: string | null;
  readonly externalRef?: string | null;
}

/** Why an insert was refused: the agent has a bot on this channel already,
 *  or the bot belongs to another agent. */
export class AgentChannelIdentityConflict extends Error {
  constructor(
    readonly reason: 'agent_has_identity' | 'bot_taken',
    message: string,
  ) {
    super(message);
    this.name = 'AgentChannelIdentityConflict';
  }
}

export interface AgentChannelIdentityStore {
  listForAgent(agentId: string): Promise<readonly AgentChannelIdentityRecord[]>;
  get(agentId: string, channelType: string): Promise<AgentChannelIdentityRecord | undefined>;
  /** The agent that owns this bot key, whatever its state. */
  ownerOf(channelType: string, channelKey: string): Promise<string | undefined>;
  insert(input: AgentChannelIdentityInput): Promise<AgentChannelIdentityRecord>;
  /** `true` when a row was removed. */
  delete(agentId: string, channelType: string): Promise<boolean>;
}

interface Row {
  agent_id: string;
  channel_type: string;
  channel_key: string;
  display_name: string | null;
  external_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'agent_id::text AS agent_id, channel_type, channel_key, display_name, external_ref, created_at, updated_at';

function toRecord(row: Row): AgentChannelIdentityRecord {
  return {
    agentId: row.agent_id,
    channelType: row.channel_type,
    channelKey: row.channel_key,
    displayName: row.display_name,
    externalRef: row.external_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uniqueViolationOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && typeof e.constraint === 'string' ? e.constraint : undefined;
}

export function createAgentChannelIdentityStore(pool: Pool): AgentChannelIdentityStore {
  return {
    async listForAgent(agentId) {
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM agent_channel_identities WHERE agent_id = $1 ORDER BY channel_type`,
        [agentId],
      );
      return rows.map(toRecord);
    },
    async get(agentId, channelType) {
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM agent_channel_identities WHERE agent_id = $1 AND channel_type = $2`,
        [agentId, channelType],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async ownerOf(channelType, channelKey) {
      const { rows } = await pool.query<{ agent_id: string }>(
        `SELECT agent_id::text AS agent_id FROM agent_channel_identities WHERE channel_type = $1 AND channel_key = $2`,
        [channelType, channelKey],
      );
      return rows[0]?.agent_id;
    },
    async insert(input) {
      try {
        const { rows } = await pool.query<Row>(
          `INSERT INTO agent_channel_identities (agent_id, channel_type, channel_key, display_name, external_ref)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${COLUMNS}`,
          [input.agentId, input.channelType, input.channelKey, input.displayName ?? null, input.externalRef ?? null],
        );
        return toRecord(rows[0]!);
      } catch (err) {
        const constraint = uniqueViolationOf(err);
        if (constraint === 'agent_channel_identities_key_unique') {
          throw new AgentChannelIdentityConflict('bot_taken', `this ${input.channelType} bot belongs to another agent`);
        }
        if (constraint === 'agent_channel_identities_pkey') {
          throw new AgentChannelIdentityConflict(
            'agent_has_identity',
            `the agent has a ${input.channelType} bot already — remove it first`,
          );
        }
        throw err;
      }
    },
    async delete(agentId, channelType) {
      const { rowCount } = await pool.query(
        'DELETE FROM agent_channel_identities WHERE agent_id = $1 AND channel_type = $2',
        [agentId, channelType],
      );
      return (rowCount ?? 0) > 0;
    },
  };
}
