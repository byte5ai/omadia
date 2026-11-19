/**
 * #2078 (spec 2043 §5.11) — kernel-issued grants for mail and calendar.
 *
 * Two facades over one store: the plugin that runs a process issues and
 * revokes grants under its own scopes; an integration asks before every
 * operation whether a grant covers it. A grant is live only while its scope
 * is, so everything that ends a scope ends its grants in the same statement.
 */

import {
  EXECUTION_GRANT_RULES,
  type ExecutionGrant,
  type ExecutionGrantKind,
  type ExecutionGrantUse,
  type ExecutionGrantsService,
  type ExecutionRefusal,
  type GrantOperation,
  type GrantRefusalCode,
  type GrantVerificationOutcome,
  type GrantVerificationService,
} from '@omadia/plugin-api';
import type { Pool } from 'pg';

const DAY_MS = 24 * 3_600_000;
/** `protocol_dispatch`: at most this long after the protocol became final. */
export const PROTOCOL_DISPATCH_MAX_MS = 7 * DAY_MS;
const MAX_RECIPIENTS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const OPERATIONS: ReadonlySet<string> = new Set(['send_mail', 'free_busy', 'create_invitation']);

interface GrantRow {
  id: string;
  scope_id: string;
  process_id: string;
  plugin_id: string;
  agent_id: string;
  scope_kind: string;
  kind: ExecutionGrantKind;
  subject: string;
  recipients: string[];
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  scope_open: boolean;
  expired: boolean;
  killed: boolean;
}

/** A grant with the state of its scope, read in one statement. */
const GRANT_SELECT = `
  SELECT g.id, g.scope_id, sc.process_id, sc.plugin_id, sc.agent_id, sc.kind AS scope_kind, g.kind, g.subject,
         g.recipients, g.issued_at, g.expires_at, g.revoked_at, g.revoke_reason,
         (sc.state = 'open' AND sc.deadline > now()) AS scope_open,
         (g.expires_at <= now()) AS expired,
         EXISTS (
           SELECT 1 FROM execution_kill_switches k
            WHERE k.cleared_at IS NULL
              AND (k.level = 'instance'
                OR (k.level = 'agent' AND k.agent_id = sc.agent_id)
                OR (k.level = 'process' AND k.agent_id = sc.agent_id AND k.process_id = sc.process_id))) AS killed
    FROM execution_grants g JOIN execution_scopes sc ON sc.id = g.scope_id`;

function toGrant(r: GrantRow): ExecutionGrant {
  return {
    id: r.id,
    scopeId: r.scope_id,
    processId: r.process_id,
    kind: r.kind,
    subject: r.subject,
    recipients: r.recipients ?? [],
    issuedAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    ...(r.revoked_at ? { revokedAt: r.revoked_at.toISOString() } : {}),
    ...(r.revoke_reason ? { revokeReason: r.revoke_reason } : {}),
    live: r.scope_open && !r.expired && r.revoked_at === null,
  };
}

/** Lower-cased, de-duplicated mail addresses; `undefined` when one is not an
 *  address. */
export function readRecipients(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_RECIPIENTS) return undefined;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return undefined;
    const address = entry.trim().toLowerCase();
    if (address.length > 320 || !MAIL.test(address)) return undefined;
    out.add(address);
  }
  return [...out];
}

const refuse = (code: ExecutionRefusal['code'], message: string): ExecutionRefusal => ({ outcome: 'refused', code, message });

export function createExecutionGrantsService(deps: {
  pool: Pool;
  /** The kernel-known id of the calling plugin. */
  callerPluginId: string;
  now?: () => Date;
  log?: (message: string) => void;
}): ExecutionGrantsService {
  const { pool, callerPluginId } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async issueGrant(request) {
      const rule = EXECUTION_GRANT_RULES[request?.kind];
      if (!rule) return refuse('invalid_request', 'unknown grant kind');
      if (typeof request.scopeId !== 'string' || !UUID.test(request.scopeId)) return refuse('unknown_scope', 'no such scope');
      const recipients = readRecipients(request.recipients);
      if (!recipients || recipients.length === 0) {
        return refuse('invalid_request', 'recipients is a non-empty list of mail addresses');
      }
      const subject = typeof request.subject === 'string' ? request.subject.trim().slice(0, 200) : '';
      const scope = await pool.query<{ kind: string; open: boolean; deadline: Date }>(
        `SELECT kind, (state = 'open' AND deadline > now()) AS open, deadline
           FROM execution_scopes WHERE id = $1 AND plugin_id = $2`,
        [request.scopeId, callerPluginId],
      );
      const row = scope.rows[0];
      // A scope of another plugin reads as unknown.
      if (!row) return refuse('unknown_scope', 'no such scope');
      if (!row.open) return refuse('scope_ended', 'this scope has ended');
      if (row.kind !== rule.scope) {
        return refuse('scope_order', `a '${request.kind}' grant is issued under a '${rule.scope}' scope, not under '${row.kind}'`);
      }
      const at = now().getTime();
      const limit = Math.min(
        row.deadline.getTime(),
        request.kind === 'protocol_dispatch' ? at + PROTOCOL_DISPATCH_MAX_MS : Number.POSITIVE_INFINITY,
      );
      let expiresAt = new Date(limit);
      if (request.expiresAt !== undefined) {
        const wanted = new Date(request.expiresAt);
        if (Number.isNaN(wanted.getTime()) || wanted.getTime() <= at) {
          return refuse('invalid_request', 'expiresAt is not a time in the future');
        }
        if (wanted.getTime() > limit) {
          return refuse('limit_exceeded', `this grant ends at the latest ${new Date(limit).toISOString()}`);
        }
        expiresAt = wanted;
      }
      // One grant per scope, kind and subject. While it is live its
      // recipients and expiry can be replaced; a revoked or expired one is
      // never revived.
      const upserted = await pool.query<{ id: string }>(
        `INSERT INTO execution_grants AS g (scope_id, kind, subject, recipients, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (scope_id, kind, subject) DO UPDATE
           SET recipients = EXCLUDED.recipients, expires_at = EXCLUDED.expires_at
         WHERE g.revoked_at IS NULL AND g.expires_at > now()
         RETURNING g.id`,
        [request.scopeId, request.kind, subject, JSON.stringify(recipients), expiresAt],
      );
      const id = upserted.rows[0]?.id;
      if (!id) return refuse('scope_exists', 'this grant was revoked or has expired; a grant is not issued twice');
      const issued = await pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [id]);
      deps.log?.(
        `[execution] grant ${request.kind}${subject ? `/${subject}` : ''} issued for process ${issued.rows[0]?.process_id ?? '?'}: ${String(recipients.length)} recipient(s), until ${expiresAt.toISOString()}`,
      );
      return { outcome: 'issued', grant: toGrant(issued.rows[0] as GrantRow) };
    },

    async revokeGrant(grantId, reason) {
      if (typeof grantId !== 'string' || !UUID.test(grantId)) return;
      await pool.query(
        `UPDATE execution_grants g SET revoked_at = now(), revoke_reason = $3
           FROM execution_scopes sc
          WHERE g.id = $1 AND sc.id = g.scope_id AND sc.plugin_id = $2 AND g.revoked_at IS NULL`,
        [grantId, callerPluginId, (typeof reason === 'string' && reason ? reason : 'revoked').slice(0, 200)],
      );
    },

    async listGrants(processId) {
      if (typeof processId !== 'string' || processId.length === 0) return [];
      const grants = await pool.query<GrantRow>(
        `${GRANT_SELECT} WHERE sc.plugin_id = $1 AND sc.process_id = $2 ORDER BY g.issued_at, g.id`,
        [callerPluginId, processId],
      );
      if (grants.rows.length === 0) return [];
      const uses = await pool.query<{
        grant_id: string;
        operation: GrantOperation;
        recipients: string[];
        asked_by: string;
        allowed: boolean;
        refusal: GrantRefusalCode | null;
        used_at: Date;
      }>(
        `SELECT grant_id, operation, recipients, asked_by, allowed, refusal, used_at
           FROM execution_grant_uses WHERE grant_id = ANY($1::uuid[]) ORDER BY used_at, id`,
        [grants.rows.map((g) => g.id)],
      );
      return grants.rows.map((g) => ({
        ...toGrant(g),
        uses: uses.rows
          .filter((u) => u.grant_id === g.id)
          .map(
            (u): ExecutionGrantUse => ({
              operation: u.operation,
              recipients: u.recipients ?? [],
              askedBy: u.asked_by,
              allowed: u.allowed,
              ...(u.refusal ? { refusal: u.refusal } : {}),
              usedAt: u.used_at.toISOString(),
            }),
          ),
      }));
    },
  };
}

export function createGrantVerificationService(deps: {
  pool: Pool;
  /** The plugin that asks (the integration); recorded with every use. */
  callerPluginId: string;
  log?: (message: string) => void;
}): GrantVerificationService {
  const { pool } = deps;

  const record = async (
    grantId: string,
    operation: string,
    recipients: readonly string[],
    refusal: GrantRefusalCode | undefined,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO execution_grant_uses (grant_id, operation, recipients, asked_by, allowed, refusal)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [grantId, operation, JSON.stringify(recipients), deps.callerPluginId, refusal === undefined, refusal ?? null],
    );
  };

  return {
    async verify(request): Promise<GrantVerificationOutcome> {
      const refused = (code: GrantRefusalCode, message: string, notCovered?: string[]): GrantVerificationOutcome => ({
        allowed: false,
        code,
        message,
        ...(notCovered ? { notCovered } : {}),
      });
      if (typeof request?.grantId !== 'string' || !UUID.test(request.grantId)) {
        return refused('unknown_grant', 'no such grant');
      }
      if (!OPERATIONS.has(request.operation)) return refused('invalid_request', 'unknown operation');
      const recipients = readRecipients(request.recipients);
      if (!recipients || recipients.length === 0) {
        return refused('invalid_request', 'recipients is a non-empty list of mail addresses');
      }
      try {
        const found = await pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [request.grantId]);
        const grant = found.rows[0];
        if (!grant) return refused('unknown_grant', 'no such grant');
        const outcome = ((): GrantVerificationOutcome => {
          if (grant.revoked_at !== null) return refused('revoked', 'this grant was revoked');
          if (!grant.scope_open) return refused('scope_ended', "this grant's execution scope has ended");
          if (grant.expired) return refused('expired', 'this grant has expired');
          if (grant.killed) return refused('kill_switch', 'stopped by an operator');
          if (!EXECUTION_GRANT_RULES[grant.kind].operations.includes(request.operation)) {
            return refused('operation_not_covered', `a '${grant.kind}' grant does not cover '${request.operation}'`);
          }
          const covered = new Set(grant.recipients ?? []);
          const notCovered = recipients.filter((address) => !covered.has(address));
          if (notCovered.length > 0) {
            return refused('recipient_not_covered', 'the grant does not cover every recipient', notCovered);
          }
          return { allowed: true, kind: grant.kind, processId: grant.process_id };
        })();
        // Every answer is a use of the grant, allowed or refused.
        await record(grant.id, request.operation, recipients, outcome.allowed ? undefined : outcome.code);
        if (!outcome.allowed) {
          deps.log?.(
            `[execution] grant ${grant.kind} of process ${grant.process_id}: '${request.operation}' asked by ${deps.callerPluginId} refused (${outcome.code})`,
          );
        }
        return outcome;
      } catch (err) {
        // Fail closed: without an answer from the database nothing is allowed.
        deps.log?.(`[execution] grant verification failed: ${err instanceof Error ? err.message : String(err)}`);
        return refused('unavailable', 'the grant could not be verified');
      }
    },
  };
}
