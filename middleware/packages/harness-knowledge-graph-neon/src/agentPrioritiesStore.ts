import type { Pool } from 'pg';

import type {
  AgentPrioritiesStore,
  AgentPriorityRecord,
  AgentPriorityUpsert,
} from '@omadia/plugin-api';

/**
 * @omadia/knowledge-graph-neon — NeonAgentPrioritiesStore (Palaia
 * Phase 5 / OB-74 Slice 1).
 *
 * Tenant-scoped Pool-backed Implementation der `agentPriorities@1`-Capability.
 * Eine Row pro (tenant, agent, entry_external_id) — siehe Migration 0008.
 *
 * Hot-Path: Der ContextRetriever-Assembler ruft pro Turn einmal `listForAgent`
 * (single round-trip), indiziert das Ergebnis lokal als Map und wendet
 * Block/Boost inline auf den scorten Hit-Pool an. Kein N+1.
 *
 * Admin-Pfad: `/admin/kg-priorities`-CRUD calls hit `upsert` / `remove` /
 * `listForAgent`.
 */

interface AgentPriorityRow {
  agent_id: string;
  entry_external_id: string;
  action: 'block' | 'boost';
  weight: number;
  reason: string | null;
  updated_at: Date | string;
}

export interface NeonAgentPrioritiesStoreOptions {
  pool: Pool;
  tenantId: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class NeonAgentPrioritiesStore implements AgentPrioritiesStore {
  private readonly pool: Pool;
  private readonly tenantId: string;

  constructor(opts: NeonAgentPrioritiesStoreOptions) {
    this.pool = opts.pool;
    this.tenantId = opts.tenantId;
  }

  async listForAgent(agentId: string): Promise<readonly AgentPriorityRecord[]> {
    const result = await this.pool.query<AgentPriorityRow>(
      `
      SELECT agent_id, entry_external_id, action, weight, reason, updated_at
        FROM agent_priorities
       WHERE tenant_id = $1
         AND agent_id = $2
       ORDER BY entry_external_id ASC
      `,
      [this.tenantId, agentId],
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      entryExternalId: row.entry_external_id,
      action: row.action,
      weight: Number(row.weight),
      reason: row.reason,
      updatedAt: toIso(row.updated_at),
    }));
  }

  async upsert(record: AgentPriorityUpsert): Promise<void> {
    if (record.action !== 'block' && record.action !== 'boost') {
      throw new Error(
        `agentPriorities.upsert: invalid action '${String(record.action)}'`,
      );
    }
    if (!Number.isFinite(record.weight) || record.weight < 0) {
      throw new Error(
        `agentPriorities.upsert: invalid weight ${String(record.weight)} (must be finite, ≥0)`,
      );
    }
    await this.pool.query(
      `
      INSERT INTO agent_priorities
        (tenant_id, agent_id, entry_external_id, action, weight, reason, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (tenant_id, agent_id, entry_external_id) DO UPDATE
        SET action     = EXCLUDED.action,
            weight     = EXCLUDED.weight,
            reason     = EXCLUDED.reason,
            updated_at = NOW()
      `,
      [
        this.tenantId,
        record.agentId,
        record.entryExternalId,
        record.action,
        record.weight,
        record.reason,
      ],
    );
  }

  async remove(agentId: string, entryExternalId: string): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM agent_priorities
       WHERE tenant_id = $1
         AND agent_id = $2
         AND entry_external_id = $3
      `,
      [this.tenantId, agentId, entryExternalId],
    );
  }
}
