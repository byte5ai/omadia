import type { Pool, PoolClient } from 'pg';

export interface ConductorRole {
  key: string;
  label: string;
  description: string | null;
  scope: string | null;
  holders: string[];
}

interface RoleRow {
  key: string;
  label: string;
  description: string | null;
  scope: string | null;
}

export class ConductorRoleNotFoundError extends Error {}
export class ConductorRoleExistsError extends Error {}
export class ConductorRoleInUseError extends Error {}

/**
 * Roles + assignments (the "baton"). The default RoleResolver: a role's current holders are the
 * assignment rows that are still open (valid_to null or future). `resolve()` is late-bound — call
 * it at dispatch and on every reminder so a moved baton routes to the current holder (FR-022).
 *
 * #754 — the external-resolver seam is filled: this store is registered as the
 * `'conductor-local'` `RoleHolderSource` (see `roleHolderResolver.ts`) alongside whatever
 * external sources (Entra, an Odoo HR org chart) the operator activates. Conductor's executor
 * and workers resolve role → holders through the `RoleHolderRegistry`, never through this
 * class's `resolve()` directly — that union carries the `partial`/`unavailable` discipline this
 * store's own `string[]` return type cannot express.
 */
export class ConductorRoleStore {
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly pool: Pool) {}

  /**
   * Spec 2042 §5.3 — called after every role or assignment write of THIS
   * process (the role-membership snapshot refreshes at once; other replicas
   * catch up on their periodic refresh). Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[conductor] role change listener failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  async createRole(input: { key: string; label: string; description?: string | null; scope?: string | null }): Promise<RoleRow> {
    const { rows } = await this.pool.query<RoleRow>(
      `INSERT INTO conductor_roles (key, label, description, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING
       RETURNING key, label, description, scope`,
      [input.key, input.label, input.description ?? null, input.scope ?? null],
    );
    if (!rows[0]) throw new ConductorRoleExistsError(input.key);
    this.changed();
    return rows[0];
  }

  async updateLabel(key: string, label: string): Promise<{ before: RoleRow; after: RoleRow }> {
    const { rows } = await this.pool.query<RoleRow & { previous_label: string }>(
      `WITH existing AS (
         SELECT key, label FROM conductor_roles WHERE key = $1 FOR UPDATE
       )
       UPDATE conductor_roles r SET label = $2 FROM existing
        WHERE r.key = existing.key
       RETURNING r.key, r.label, r.description, r.scope, existing.label AS previous_label`,
      [key, label],
    );
    if (!rows[0]) throw new ConductorRoleNotFoundError(key);
    const { previous_label, ...after } = rows[0];
    this.changed();
    return { before: { ...after, label: previous_label }, after };
  }

  async deleteRole(key: string): Promise<RoleRow> {
    return this.withLockedRole(key, async (client, role) => {
      const { rows } = await client.query<{ referenced: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM conductor_role_assignments
            WHERE role_key = $1 AND (valid_to IS NULL OR valid_to > now())
         ) OR EXISTS (
           SELECT 1 FROM conductor_workflows w
             JOIN conductor_workflow_versions v ON v.id = w.active_version_id
            WHERE w.reaped_at IS NULL AND v.graph->'steps' @> $2::jsonb
         ) AS referenced`,
        [key, JSON.stringify([{ human: { principal: { kind: 'role', ref: key } } }])],
      );
      if (rows[0]?.referenced) throw new ConductorRoleInUseError(key);
      await client.query('DELETE FROM conductor_roles WHERE key = $1', [key]);
      return role;
    });
  }

  private async withLockedRole<T>(
    key: string,
    mutate: (client: PoolClient, role: RoleRow) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<RoleRow>(
        'SELECT key, label, description, scope FROM conductor_roles WHERE key = $1 FOR UPDATE',
        [key],
      );
      if (!rows[0]) throw new ConductorRoleNotFoundError(key);
      const result = await mutate(client, rows[0]);
      await client.query('COMMIT');
      this.changed();
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Current holders of a role (the default resolver). Re-resolved live — never frozen. */
  async resolve(roleKey: string): Promise<string[]> {
    const r = await this.pool.query<{ holder_id: string }>(
      `SELECT holder_id FROM conductor_role_assignments
        WHERE role_key = $1 AND (valid_to IS NULL OR valid_to > now())
        ORDER BY valid_from ASC`,
      [roleKey],
    );
    return r.rows.map((row) => row.holder_id);
  }

  /** Every role key, without resolving holders. */
  async listRoleKeys(): Promise<string[]> {
    const { rows } = await this.pool.query<{ key: string }>('SELECT key FROM conductor_roles ORDER BY key');
    return rows.map((row) => row.key);
  }

  async listRoles(): Promise<ConductorRole[]> {
    const roles = await this.pool.query<RoleRow>('SELECT key, label, description, scope FROM conductor_roles ORDER BY key');
    const out: ConductorRole[] = [];
    for (const role of roles.rows) {
      out.push({ ...role, holders: await this.resolve(role.key) });
    }
    return out;
  }

  /** Add a holder (open a new assignment). Fires conductor_role_changed (notify trigger). */
  async addHolder(roleKey: string, holderId: string): Promise<void> {
    await this.withLockedRole(roleKey, async (client) => {
      await client.query(
        `INSERT INTO conductor_role_assignments (role_key, holder_id, provenance)
         SELECT $1, $2, 'manual'
          WHERE NOT EXISTS (
            SELECT 1 FROM conductor_role_assignments
             WHERE role_key = $1 AND holder_id = $2 AND (valid_to IS NULL OR valid_to > now())
          )`,
        [roleKey, holderId],
      );
    });
  }

  /** Move the baton: close the open holder's assignment (a removeHolder + addHolder = a move). */
  async removeHolder(roleKey: string, holderId: string): Promise<void> {
    await this.withLockedRole(roleKey, async (client) => {
      await client.query(
        `UPDATE conductor_role_assignments SET valid_to = now()
          WHERE role_key = $1 AND holder_id = $2 AND valid_to IS NULL`,
        [roleKey, holderId],
      );
    });
  }
}
