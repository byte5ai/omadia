import type { Request } from 'express';
import type { Pool } from 'pg';

// Type-only: the augmentation that puts `session?: SessionClaims` on Request.
import type {} from './requireAuth.js';

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
  | 'channel.binding_change'
  // #330 round 4 — the operator terminated a live facilitation from the admin lens.
  | 'conductor.facilitation_terminate'
  // #965 — an operator extended their own session ("I'm still here"). One
  // row per renewal keeps a renewal chain visible after the fact.
  | 'auth.session_renew'
  // The first principal of an install came into being (setup wizard or the
  // ADMIN_BOOTSTRAP_* env seed). Written in the SAME transaction as the users
  // row, so an install can never have a first admin without this record.
  | 'auth.first_admin_create'
  // The password sign-in limiter refused a client (§10m). One row per refusal
  // episode (the first refusal of a scope + client per minute), system actor;
  // `target` is the client key, `after` the scope and Retry-After. Never the
  // account that was tried.
  | 'auth.login_rate_limited'
  // #1315 — a password sign-in that failed verification. One row per
  // (account, client) per minute (`auth/loginFailureAudit.ts`), system actor;
  // `target` is the client key, `after` the account only as the users row it
  // resolves to, and the provider. Never the typed text or the password.
  | 'auth.login_failed'
  // #1347 — operator consent for a plugin's unauthenticated public paths and
  // its SQL grant. `before`/`after` carry the granted set, so the history
  // survives a revoke that DELETEs the grant row.
  | 'plugin.grants_change'
  // #1347 — a plugin finished its install wizard / was removed. The uninstall
  // row lists the grants that left with it.
  | 'plugin.install'
  | 'plugin.uninstall'
  // #1510/#1508 — a plugin's Privacy Shield setting (`_privacy_mode`,
  // `_privacy_bypass_scopes`) changed. A switch to `bypass` sends that
  // plugin's raw results to the LLM, so who flipped it belongs in the trail.
  // `before`/`after` carry only those two keys.
  | 'plugin.privacy_change'
  // #1342 — a stdio MCP server was saved (manual or catalog import). It runs
  // as a child process of the middleware, so who added it belongs in the
  // trail. `after` holds name + source, never the command line.
  | 'mcp_server.stdio_create'
  // #1329 — public API-key lifecycle (`@omadia/channel-api` /admin/keys),
  // written through `ctx.operatorAuth.recordAdminAction`. Never carries the
  // token or its hash.
  // #1336 — a Danger-Zone memory purge. Written before anything is deleted,
  // in the same transaction as its `memory_purge_audit` row (which then gets
  // the outcome); `target` is `memory-purge:<that row's id>`.
  | 'memory.purge'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'api_key.delete';

/**
 * #1329 — the actions a PLUGIN may write via
 * `ctx.operatorAuth.recordAdminAction`, who may write them and what they may
 * point at. Keyed on action AND plugin: a plugin must never be able to forge
 * a kernel event (`user.delete`, `auth.provider_disable`) or another plugin's
 * event into the ledger an incident responder trusts.
 */
const API_KEY_TARGET = /^api-key:[0-9a-f-]{36}$/;
const API_KEY_PLUGINS: readonly string[] = ['@omadia/channel-api'];

export const PLUGIN_AUDIT_POLICY: Readonly<
  Partial<Record<AuditAction, { readonly plugins: readonly string[]; readonly target: RegExp }>>
> = {
  'api_key.create': { plugins: API_KEY_PLUGINS, target: API_KEY_TARGET },
  'api_key.revoke': { plugins: API_KEY_PLUGINS, target: API_KEY_TARGET },
  'api_key.delete': { plugins: API_KEY_PLUGINS, target: API_KEY_TARGET },
};

/** True when `pluginId` may write `action` against `target`. */
export function isPluginAuditAllowed(pluginId: string, action: string, target: string): boolean {
  const policy = (PLUGIN_AUDIT_POLICY as Record<string, (typeof PLUGIN_AUDIT_POLICY)[AuditAction]>)[
    action
  ];
  return !!policy && policy.plugins.includes(pluginId) && policy.target.test(target);
}


export interface AuditActor {
  id?: string;
  email?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The actor of a row whose writer only has a free-form label: a users.id, an
 * email, or a system name such as `conductor-ephemeral-reaper`. Only a uuid
 * goes to `id` — anything else in the uuid column makes the INSERT fail and
 * the row is lost (#775) — and the label is kept in `email`, the free-text
 * column, so it is not lost either.
 */
export function auditActorFromLabel(label: string | undefined): AuditActor {
  if (!label) return {};
  return UUID_RE.test(label) ? { id: label } : { email: label };
}

/**
 * #1315 — THE actor of an audit row written on behalf of a signed-in user.
 * Every writer that has a request uses this, so no event type can drift into
 * its own convention again.
 *
 * `id` is the `users.id` the session was minted for (claim `uid`) — the same
 * uuid `auth.session_renew` and `auth.first_admin_create` store. Not
 * `omadia_user_id` (the knowledge-graph cluster id, another namespace) and
 * not `sub` (an email for local accounts — #775: an email in the uuid column
 * makes the INSERT fail). A token minted before `uid` existed yields no id,
 * never a guess. `email` is denormalised for reading the trail.
 *
 * No session (a public route, a test harness) → `{}`, the system actor.
 */
export function auditActorFromRequest(req: Request): AuditActor {
  const session = req.session;
  if (!session) return {};
  const uid = session.uid;
  return {
    ...(typeof uid === 'string' && UUID_RE.test(uid) ? { id: uid } : {}),
    ...(session.email ? { email: session.email } : {}),
  };
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

/**
 * The INSERT for one audit row, as text + values. Shared by
 * `AdminAuditLog.record` (its own pool query) and by writers that must put
 * the row into a transaction they already hold (`UserStore.createFirstAdmin`),
 * so the column mapping exists exactly once.
 */
export function auditInsertStatement(entry: AuditEntryInput): {
  text: string;
  values: unknown[];
} {
  return {
    text: `INSERT INTO admin_audit (actor_id, actor_email, action, target, before, after)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    values: [
      entry.actor.id ?? null,
      entry.actor.email ?? null,
      entry.action,
      entry.target,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  };
}

export class AdminAuditLog {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditEntryInput): Promise<void> {
    const { text, values } = auditInsertStatement(entry);
    await this.pool.query(text, values);
  }

  /**
   * Newest first. `action` is an exact action (`user.create`) or a prefix
   * ending in `.` (`user.`); `actorId` filters on the uuid. Both are bound
   * parameters — the prefix's LIKE metacharacters are escaped, so `_` in an
   * action name matches only itself.
   */
  async list(opts: AuditListOptions = {}): Promise<AuditEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.action !== undefined) {
      if (opts.action.endsWith('.')) {
        values.push(`${escapeLike(opts.action)}%`);
        // Backslash is Postgres's default LIKE escape — no ESCAPE clause, so the
        // text does not depend on standard_conforming_strings.
        where.push(`action LIKE $${String(values.length)}`);
      } else {
        values.push(opts.action);
        where.push(`action = $${String(values.length)}`);
      }
    }
    if (opts.actorId !== undefined) {
      values.push(opts.actorId);
      where.push(`actor_id = $${String(values.length)}`);
    }
    values.push(limit, offset);
    const res = await this.pool.query<AuditRow>(
      `SELECT * FROM admin_audit
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${String(values.length - 1)} OFFSET $${String(values.length)}`,
      values,
    );
    return res.rows.map(rowToEntry);
  }
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
  action?: string;
  actorId?: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
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
 * the caller's actor label (the session email, else the sub) goes to `email`;
 * for the `'operator'` fallback it is the only place the actor can be
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
