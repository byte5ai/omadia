import type { Pool } from 'pg';

/**
 * Append-only ledger of privileged admin actions (user CRUD, provider
 * toggle, password reset). Backs the OB-50 admin-UI's compliance story:
 * an operator can answer "who disabled Entra last week?" with a single
 * SELECT, and a future SOC2 audit pulls the same table.
 *
 * Reads are intentionally plain `list()` — we don't expose the audit log
 * to non-admin users, and `before`/`after` JSON snapshots stay verbatim so
 * a reader can diff them without us having to predict which fields they
 * care about.
 */

export type AuditAction =
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.reset_password'
  | 'auth.provider_enable'
  | 'auth.provider_disable'
  // Phase 2.2 (OB-64) — profile-snapshot lifecycle
  | 'profile_snapshot.create'
  | 'profile_snapshot.mark_deploy_ready'
  | 'profile_snapshot.rollback'
  // #759 — Conductor role-holder (baton) changes: who may approve is a
  // security decision and belongs in the trail (any operator can assign
  // themselves — the single-role system has no finer permission today).
  | 'conductor.role_holders_change'
  // #330 C2a — plugin-driven conversation bind/unbind: a binding decides
  // which Agent answers a group, so the auto-bind lifecycle belongs in the
  // same trail as the role batons.
  | 'channel.binding_change';

export interface AuditActor {
  id?: string;
  email?: string;
}

export interface AuditEntryInput {
  actor: AuditActor;
  action: AuditAction;
  /** Entity ref: 'user:<uuid>' | 'provider:<id>'. Free-form so future
   *  actions don't need a schema bump. */
  target: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  created_at: Date;
}

export class AdminAuditLog {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditEntryInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_audit (actor_id, actor_email, action, target, before, after)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.actor.id ?? null,
        entry.actor.email ?? null,
        entry.action,
        entry.target,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
  }

  async list(opts: { limit?: number; offset?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const res = await this.pool.query<AuditRow>(
      `SELECT * FROM admin_audit
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(rowToEntry);
  }
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    before: row.before,
    after: row.after,
    createdAt: row.created_at,
  };
}

/**
 * #775 — map a conductor role-holder change to an audit entry WITHOUT ever
 * putting a non-uuid into `actor_id`.
 *
 * The bug this fixes: the index.ts closure passed the session sub (an email,
 * e.g. `demo@byte5.de`) as `actor.id`; `admin_audit.actor_id` is a uuid
 * column, so EVERY write failed — loudly in the log, but the audit trail for
 * baton moves (the entire point of #759) stayed empty on any install using
 * email subs, i.e. the normal local-auth case.
 *
 * Mapping: the uuid goes to `id` only when the session actually carried one;
 * the sub always goes to `email` — same treatment the adminUsers routes give
 * it, and for the `'operator'` fallback it is the only place the actor can be
 * preserved at all (the column is free-text, like `target`).
 */
export function roleChangeAuditEntry(entry: {
  actor: string;
  actorUserId?: string;
  roleKey: string;
  action: 'add' | 'remove';
  holderId: string;
  holdersAfter: readonly string[];
}): AuditEntryInput {
  return {
    actor: { id: entry.actorUserId, email: entry.actor },
    action: 'conductor.role_holders_change',
    target: `conductor-role:${entry.roleKey}`,
    before: { action: entry.action, holderId: entry.holderId },
    after: { holders: [...entry.holdersAfter] },
  };
}
