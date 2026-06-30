import type { Pool } from 'pg';

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

/**
 * Roles + assignments (the "baton"). The default RoleResolver: a role's current holders are the
 * assignment rows that are still open (valid_to null or future). `resolve()` is late-bound — call
 * it at dispatch and on every reminder so a moved baton routes to the current holder (FR-022). An
 * integration could register an external resolver in front of this; that seam is a follow-up.
 */
export class ConductorRoleStore {
  constructor(private readonly pool: Pool) {}

  async createRole(input: { key: string; label: string; description?: string | null; scope?: string | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conductor_roles (key, label, description, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, scope = EXCLUDED.scope`,
      [input.key, input.label, input.description ?? null, input.scope ?? null],
    );
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
    // idempotent: skip if already an open holder
    const existing = await this.resolve(roleKey);
    if (existing.includes(holderId)) return;
    await this.pool.query(
      `INSERT INTO conductor_role_assignments (role_key, holder_id, provenance) VALUES ($1, $2, 'manual')`,
      [roleKey, holderId],
    );
  }

  /** Move the baton: close the open holder's assignment (a removeHolder + addHolder = a move). */
  async removeHolder(roleKey: string, holderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_role_assignments SET valid_to = now()
        WHERE role_key = $1 AND holder_id = $2 AND valid_to IS NULL`,
      [roleKey, holderId],
    );
  }
}
