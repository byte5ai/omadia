import type { Pool } from 'pg';

import type { AgentComputerProfile } from './agentComputerProfile.js';
import type {
  SandboxRegistry,
  SandboxRegistryEntry,
  SandboxRegistryUpsertInput,
} from './sandboxRegistry.js';

/**
 * Postgres-backed `SandboxRegistry` — migration `0044_sandbox_registry.sql`.
 * Schema is intentionally narrow (see that file's header for the numbering
 * note). `profile` round-trips through `JSONB` verbatim; nothing here
 * validates its shape beyond `JSON.parse` succeeding — the caller (P2's
 * `execute` tool wiring, or a future consumer) owns the `AgentComputerProfile`
 * contract, this store just persists whatever it is handed.
 */
export class PostgresSandboxRegistry implements SandboxRegistry {
  constructor(private readonly pool: Pool) {}

  async get(scopeKey: string): Promise<SandboxRegistryEntry | undefined> {
    const result = await this.pool.query<RegistryRow>(
      `SELECT scope_key, backend, sandbox_ref, profile, ro_layer_hash, created_at, last_used_at
       FROM sandbox_registry WHERE scope_key = $1`,
      [scopeKey],
    );
    const row = result.rows[0];
    return row ? rowToEntry(row) : undefined;
  }

  async upsert(input: SandboxRegistryUpsertInput): Promise<SandboxRegistryEntry> {
    const result = await this.pool.query<RegistryRow>(
      `INSERT INTO sandbox_registry (scope_key, backend, sandbox_ref, profile, ro_layer_hash, created_at, last_used_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
       ON CONFLICT (scope_key) DO UPDATE SET
         backend = EXCLUDED.backend,
         sandbox_ref = EXCLUDED.sandbox_ref,
         profile = EXCLUDED.profile,
         ro_layer_hash = COALESCE(EXCLUDED.ro_layer_hash, sandbox_registry.ro_layer_hash),
         last_used_at = EXCLUDED.last_used_at
       RETURNING scope_key, backend, sandbox_ref, profile, ro_layer_hash, created_at, last_used_at`,
      [
        input.scopeKey,
        input.backend,
        input.sandboxRef,
        JSON.stringify(input.profile),
        input.roLayerHash ?? null,
        input.now.toISOString(),
      ],
    );
    return rowToEntry(result.rows[0] as RegistryRow);
  }

  async touch(scopeKey: string, now: Date): Promise<void> {
    await this.pool.query(`UPDATE sandbox_registry SET last_used_at = $2 WHERE scope_key = $1`, [
      scopeKey,
      now.toISOString(),
    ]);
  }

  async delete(scopeKey: string): Promise<void> {
    await this.pool.query(`DELETE FROM sandbox_registry WHERE scope_key = $1`, [scopeKey]);
  }

  async listAll(): Promise<readonly SandboxRegistryEntry[]> {
    const result = await this.pool.query<RegistryRow>(
      `SELECT scope_key, backend, sandbox_ref, profile, ro_layer_hash, created_at, last_used_at FROM sandbox_registry`,
    );
    return result.rows.map(rowToEntry);
  }
}

interface RegistryRow {
  scope_key: string;
  backend: string;
  sandbox_ref: string;
  profile: AgentComputerProfile;
  ro_layer_hash: string | null;
  created_at: Date;
  last_used_at: Date;
}

function rowToEntry(row: RegistryRow): SandboxRegistryEntry {
  return {
    scopeKey: row.scope_key,
    backend: row.backend,
    sandboxRef: row.sandbox_ref,
    profile: row.profile,
    ...(row.ro_layer_hash !== null ? { roLayerHash: row.ro_layer_hash } : {}),
    createdAt: new Date(row.created_at),
    lastUsedAt: new Date(row.last_used_at),
  };
}
