import type { Pool } from 'pg';

/**
 * Thin Postgres-backed CRUD over the `users` table introduced by
 * `auth/migrations/0001_users.sql`. Provider-aware throughout: every read
 * scopes by `(provider, ...)`, every write spells the provider out — so
 * adding a new AuthProvider doesn't require touching this layer beyond
 * passing a different `provider` string.
 *
 * Email comparison is always case-insensitive (`LOWER(email)`) — the
 * unique index in the migration is on `(provider, LOWER(email))` so the DB
 * mirrors that contract.
 */

export type UserRole = 'admin';
export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  id: string;
  email: string;
  provider: string;
  providerUserId: string;
  /** Always undefined when read out — we never hand the hash to callers. */
  passwordHash?: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface CreateUserInput {
  email: string;
  provider: string;
  providerUserId: string;
  /** Required iff provider === 'local'; the DB CHECK constraint enforces. */
  passwordHash?: string;
  displayName?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash?: string;
}

interface UserRow {
  id: string;
  email: string;
  provider: string;
  provider_user_id: string;
  password_hash: string | null;
  display_name: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

function rowToRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    displayName: row.display_name,
    role: (row.role as UserRole),
    status: (row.status as UserStatus),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Returns rowToRecord output, but also includes passwordHash. Only used by
 *  authentication flows where the hash needs to be verified — never by
 *  list/admin endpoints. */
function rowToRecordWithHash(row: UserRow): UserRecord {
  const base = rowToRecord(row);
  return row.password_hash != null
    ? { ...base, passwordHash: row.password_hash }
    : base;
}

export class UserStore {
  constructor(private readonly pool: Pool) {}

  async count(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users',
    );
    return Number.parseInt(res.rows[0]?.count ?? '0', 10);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  }

  /** Look up by case-insensitive email within a single provider. */
  async findByEmail(
    provider: string,
    email: string,
  ): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users
       WHERE provider = $1 AND LOWER(email) = LOWER($2)
       LIMIT 1`,
      [provider, email],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  }

  /** Variant of findByEmail that includes the password hash — only auth-
   *  callers should use this. */
  async findByEmailWithHash(
    provider: string,
    email: string,
  ): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users
       WHERE provider = $1 AND LOWER(email) = LOWER($2)
       LIMIT 1`,
      [provider, email],
    );
    const row = res.rows[0];
    return row ? rowToRecordWithHash(row) : null;
  }

  async findByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users
       WHERE provider = $1 AND provider_user_id = $2
       LIMIT 1`,
      [provider, providerUserId],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async list(opts: { limit?: number; offset?: number } = {}): Promise<UserRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(rowToRecord);
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const res = await this.pool.query<UserRow>(
      `INSERT INTO users
        (email, provider, provider_user_id, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.email,
        input.provider,
        input.providerUserId,
        input.passwordHash ?? null,
        input.displayName ?? '',
        input.role ?? 'admin',
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('users INSERT returned no row');
    return rowToRecord(row);
  }

  /**
   * Upsert an OIDC-managed identity. Used by every successful OIDC login
   * (Entra and future plugins) so the users-table reflects every human
   * who has ever authenticated, even when their account lives at the
   * IdP. Without this the /setup wizard would stay unlocked in a pure-
   * OIDC deployment because `count()` would never grow past 0.
   *
   * Match key: `(provider, provider_user_id)` — stable per IdP. Email
   * + displayName get refreshed on every login since both can change at
   * the IdP (rename, alias, …) and we want our own admin views to track.
   */
  async upsertOidcIdentity(input: {
    provider: string;
    providerUserId: string;
    email: string;
    displayName?: string;
    role?: UserRole;
  }): Promise<UserRecord> {
    const res = await this.pool.query<UserRow>(
      `INSERT INTO users
        (email, provider, provider_user_id, password_hash, display_name, role)
       VALUES ($1, $2, $3, NULL, $4, $5)
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = CASE
           WHEN EXCLUDED.display_name IS NOT NULL AND EXCLUDED.display_name <> ''
             THEN EXCLUDED.display_name
           ELSE users.display_name
         END
       RETURNING *`,
      [
        input.email,
        input.provider,
        input.providerUserId,
        input.displayName ?? '',
        input.role ?? 'admin',
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('users UPSERT returned no row');
    return rowToRecord(row);
  }

  async update(id: string, patch: UpdateUserInput): Promise<UserRecord | null> {
    // Hand-rolled SET-clause builder so we only update fields that were
    // explicitly passed (preserves NULL semantics for last_login_at etc.).
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.displayName !== undefined) {
      sets.push(`display_name = $${i++}`);
      values.push(patch.displayName);
    }
    if (patch.role !== undefined) {
      sets.push(`role = $${i++}`);
      values.push(patch.role);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.passwordHash !== undefined) {
      sets.push(`password_hash = $${i++}`);
      values.push(patch.passwordHash);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }
    values.push(id);
    const res = await this.pool.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async markLoginNow(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [id],
    );
  }

  async deleteById(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
