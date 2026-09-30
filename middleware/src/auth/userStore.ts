import type { Pool } from 'pg';

import { auditInsertStatement, type AuditEntryInput } from './adminAuditLog.js';
import { SETUP_TOKEN_SETTING_KEY } from './setupToken.js';

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

/** Which path created an install's first principal; recorded in the audit row. */
export type FirstAdminVia = 'setup_wizard' | 'env_seed';

export interface CreateFirstAdminInput {
  email: string;
  provider: string;
  providerUserId: string;
  /** Hashed by the caller BEFORE the call, so the table lock is held for
   *  milliseconds rather than for an argon2 run. */
  passwordHash: string;
  displayName: string;
  via: FirstAdminVia;
}

export type FirstAdminResult =
  | { outcome: 'created'; user: UserRecord }
  | { outcome: 'not_empty'; totalUsers: number };

/**
 * How long the first-admin transaction waits for the `users` table lock. A
 * holder normally keeps it for milliseconds; running out means something is
 * holding a conflicting lock far longer, and the caller answers "try again"
 * (409) instead of queueing. Same budget as the auth migrator's lock wait.
 */
export const FIRST_ADMIN_LOCK_WAIT_MS = 2_000;

/**
 * SHARE ROW EXCLUSIVE conflicts with itself (two first-admin transactions
 * serialise) and with ROW EXCLUSIVE, the lock every INSERT/UPDATE/DELETE on
 * `users` takes — the admin-UI create, the OIDC first-sign-in upsert and the
 * env seed alike, none of which had to change for it. Plain SELECTs (ACCESS
 * SHARE: `/providers`' count, sign-in lookups) are NOT blocked. Never ACCESS
 * EXCLUSIVE: that would stall every read of the table for the duration.
 */
export const FIRST_ADMIN_LOCK_SQL = 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE';

/** Postgres `lock_not_available`, raised when `lock_timeout` expires. */
const LOCK_TIMEOUT_SQLSTATE = '55P03';

/** True for the error `createFirstAdmin` throws when the table lock wait ran out. */
export function isLockTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === LOCK_TIMEOUT_SQLSTATE
  );
}

const COUNT_USERS_SQL = 'SELECT COUNT(*)::text AS count FROM users';

const INSERT_USER_SQL = `INSERT INTO users
        (email, provider, provider_user_id, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`;

function firstAdminAuditEntry(user: UserRecord, via: FirstAdminVia): AuditEntryInput {
  return {
    // The wizard's caller IS the new admin. The env seed has no human actor —
    // actor_id NULL is how admin_audit spells a system action.
    actor: via === 'setup_wizard' ? { id: user.id, email: user.email } : {},
    action: 'auth.first_admin_create',
    target: `user:${user.id}`,
    after: {
      email: user.email,
      provider: user.provider,
      role: user.role,
      display_name: user.displayName,
      via,
    },
  };
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
    const res = await this.pool.query<{ count: string }>(COUNT_USERS_SQL);
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

  /**
   * Plain INSERT for the admin-UI user CRUD, where an operator already
   * exists. NOT for the first principal of an install — that is
   * `createFirstAdmin`, whose emptiness check and INSERT are one atomic step.
   */
  async create(input: CreateUserInput): Promise<UserRecord> {
    const res = await this.pool.query<UserRow>(INSERT_USER_SQL, [
      input.email,
      input.provider,
      input.providerUserId,
      input.passwordHash ?? null,
      input.displayName ?? '',
      input.role ?? 'admin',
    ]);
    const row = res.rows[0];
    if (!row) throw new Error('users INSERT returned no row');
    return rowToRecord(row);
  }

  /**
   * Create the install's first admin iff the `users` table is still empty —
   * the emptiness check and the INSERT as ONE atomic step.
   *
   * Why not `count()` then `create()`: they run on different pool
   * connections, so N concurrent callers all see 0 and all insert — N admins
   * with distinct emails, or a unique violation (500) with the same one.
   * Why not `INSERT … WHERE NOT EXISTS (SELECT 1 FROM users)`: under READ
   * COMMITTED each statement's NOT EXISTS runs against a snapshot that cannot
   * see the other's uncommitted row, so both still insert; the unique indexes
   * only collide on an identical email.
   *
   * So, in one transaction: bound the lock wait (`SET LOCAL lock_timeout`,
   * reverted at COMMIT/ROLLBACK so the pooled connection comes back clean),
   * take `FIRST_ADMIN_LOCK_SQL`, THEN count. The lock waits for every writer
   * already in flight to finish — a first-admin transaction, an OIDC
   * first-sign-in upsert, an admin-UI create — and the COUNT that follows
   * gets a fresh READ COMMITTED snapshot, so it sees whatever they committed.
   * A non-empty table rolls back and reports `not_empty`; an expired wait
   * throws the pg error (`isLockTimeout` → the caller answers 409).
   *
   * The audit row and the removal of a persisted setup token commit in the
   * same transaction: there is never a first admin without its audit record,
   * and never a live setup token after one exists.
   */
  async createFirstAdmin(input: CreateFirstAdminInput): Promise<FirstAdminResult> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '${String(FIRST_ADMIN_LOCK_WAIT_MS)}ms'`);
        await client.query(FIRST_ADMIN_LOCK_SQL);
        const counted = await client.query<{ count: string }>(COUNT_USERS_SQL);
        const total = Number.parseInt(counted.rows[0]?.count ?? '0', 10);
        if (total > 0) {
          await client.query('ROLLBACK');
          return { outcome: 'not_empty', totalUsers: total };
        }

        const inserted = await client.query<UserRow>(INSERT_USER_SQL, [
          input.email,
          input.provider,
          input.providerUserId,
          input.passwordHash,
          input.displayName,
          'admin',
        ]);
        const row = inserted.rows[0];
        if (!row) throw new Error('users INSERT returned no row');
        const user = rowToRecord(row);

        const audit = auditInsertStatement(firstAdminAuditEntry(user, input.via));
        await client.query(audit.text, audit.values);
        await client.query('DELETE FROM platform_settings WHERE key = $1', [
          SETUP_TOKEN_SETTING_KEY,
        ]);
        await client.query('COMMIT');
        return { outcome: 'created', user };
      } catch (err) {
        // ROLLBACK also releases the table lock. Its own failure must not
        // replace the error that caused it — but it does mean the connection
        // is unusable, so it is destroyed instead of returned to the pool.
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          broken =
            rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        });
        throw err;
      }
    } finally {
      client.release(broken);
    }
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
