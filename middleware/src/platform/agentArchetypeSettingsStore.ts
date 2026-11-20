// #2066 — per-agent settings of the agent's archetype (migration 0107,
// spec 2043 §7). The values are validated against the archetype's declared
// fields BEFORE they reach this store (`validateArchetypeAgentSettings`); the
// store only reads and merges the JSON object on the agent row.

import type { Pool } from 'pg';

import { liveAgentRow, type ArchetypeAgentSettingValue } from '@omadia/orchestrator';

export interface AgentArchetypeSettingsStore {
  /** The stored object; `{}` when nothing is set or the agent is unknown. */
  get(agentId: string): Promise<Readonly<Record<string, unknown>>>;
  /**
   * Merge `changes` into the stored object: a value sets the key, `null`
   * removes it. Returns the stored object afterwards; `undefined` when the
   * agent does not exist.
   */
  merge(
    agentId: string,
    changes: Readonly<Record<string, ArchetypeAgentSettingValue | null>>,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
}

const asObject = (raw: unknown): Readonly<Record<string, unknown>> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

export function createAgentArchetypeSettingsStore(pool: Pick<Pool, 'query'>): AgentArchetypeSettingsStore {
  return {
    async get(agentId) {
      const { rows } = await pool.query<{ archetype_settings: unknown }>(
        // A deleted agent (tombstone) has no settings any more.
        `SELECT archetype_settings FROM agents a WHERE a.id = $1 AND ${liveAgentRow('a')}`,
        [agentId],
      );
      return asObject(rows[0]?.archetype_settings);
    },
    async merge(agentId, changes) {
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null));
      const removed = Object.entries(changes)
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      // One statement: merge the new values, then drop the cleared keys.
      const { rows } = await pool.query<{ archetype_settings: unknown }>(
        `UPDATE agents a
            SET archetype_settings = (a.archetype_settings || $2::jsonb) - $3::text[]
          WHERE a.id = $1 AND ${liveAgentRow('a')}
        RETURNING a.archetype_settings`,
        [agentId, JSON.stringify(set), removed],
      );
      return rows[0] ? asObject(rows[0].archetype_settings) : undefined;
    },
  };
}
