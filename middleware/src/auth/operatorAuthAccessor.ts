import { parseCookie as parseCookieHeader } from 'cookie';
import type {
  OperatorAdminAuditEntry,
  OperatorAuthAccessor,
  OperatorPrincipal,
} from '@omadia/plugin-api';

import { isPluginAuditAllowed, type AuditAction, type AuditEntryInput } from './adminAuditLog.js';
import {
  evaluateSessionToken,
  SESSION_COOKIE,
  type SessionEvaluationDeps,
} from './requireAuth.js';

/** The slice of `AdminAuditLog` the accessor writes through. */
export interface AdminAuditWriter {
  record(entry: AuditEntryInput): Promise<void>;
}

/**
 * #1329 — late-bound `admin_audit` writer. `ctx.operatorAuth` is built long
 * before the Postgres pool that holds `admin_audit` exists (same reason
 * `SessionRevocationGuard` is late-bound), so the real `AdminAuditLog` is
 * attached once it does. Unattached (no-Postgres mode) every write is refused
 * and `recordAdminAction` resolves `false`.
 */
export class LateBoundAdminAudit {
  private writer: AdminAuditWriter | undefined;

  attach(writer: AdminAuditWriter): void {
    this.writer = writer;
  }

  get current(): AdminAuditWriter | undefined {
    return this.writer;
  }
}

/** Cap on each serialized `before`/`after` payload of a plugin-written row. */
const MAX_AUDIT_PAYLOAD_BYTES = 4096;

/**
 * The kernel's `ctx.operatorAuth`, before it is scoped to a plugin. Its own
 * `recordAdminAction` refuses every write: a row is only ever written through
 * `recordForPlugin`, which the per-plugin wrapper calls with the plugin id the
 * KERNEL knows — so the plugin id is part of the authorization decision, not
 * a label the plugin chooses.
 */
export interface KernelOperatorAuth extends OperatorAuthAccessor {
  recordForPlugin(
    pluginId: string,
    cookieHeader: string | undefined,
    entry: OperatorAdminAuditEntry,
  ): Promise<boolean>;
}

function isKernelOperatorAuth(auth: OperatorAuthAccessor): auth is KernelOperatorAuth {
  return typeof (auth as Partial<KernelOperatorAuth>).recordForPlugin === 'function';
}

function payloadTooLarge(payload: Readonly<Record<string, unknown>> | undefined): boolean {
  return payload !== undefined && Buffer.byteLength(JSON.stringify(payload)) > MAX_AUDIT_PAYLOAD_BYTES;
}

export interface OperatorAuthAccessorDeps extends SessionEvaluationDeps {
  /** Where `recordAdminAction` writes. Absent → every write resolves `false`. */
  readonly audit?: LateBoundAdminAudit;
  readonly log?: (line: string) => void;
}

/**
 * Issue #438 follow-up — kernel-side implementation of the plugin-facing
 * `ctx.operatorAuth` accessor. Wraps `evaluateSessionToken`, the EXACT SAME
 * session-verification logic `requireAuth` runs for every gated
 * `/api/v1/*` route, so a plugin that needs an operator-only admin surface
 * (e.g. `@omadia/channel-api`'s `/admin/keys`) can reuse it instead of
 * re-implementing — and risking drifting from — the kernel's own session
 * rules. There is exactly one code path that decides session validity; this
 * is a thin adapter from "raw Cookie header" to that path, not a second one —
 * so a revoked session (`deps.sessions`) is refused here exactly as it is on
 * every `/api` route.
 *
 * #1329 adds `sessionPrincipal` and `recordAdminAction` on top of the same
 * path: the actor of an audit row is always derived from the verified
 * session here, never taken from the plugin.
 */
export function createOperatorAuthAccessor(
  deps: OperatorAuthAccessorDeps,
): KernelOperatorAuth {
  const log = deps.log ?? ((line: string) => console.warn(line));

  async function principalOf(cookieHeader: string | undefined): Promise<OperatorPrincipal | null> {
    if (!cookieHeader) return null;
    let parsed: Record<string, string | undefined>;
    try {
      parsed = parseCookieHeader(cookieHeader);
    } catch {
      // Malformed Cookie header — never throw out of this accessor.
      return null;
    }
    try {
      const result = await evaluateSessionToken(parsed[SESSION_COOKIE], deps);
      // `auth.unavailable` (revocation lookup failed) is refused too: an
      // unverifiable session is not valid.
      if (!result.ok) return null;
      // `uid` is `users.id`; `sub` is provider-internal (an email for local
      // users) and `omadia_user_id` is the KG cluster id — neither belongs in
      // `admin_audit.actor_id`, which is a uuid column.
      return {
        ...(result.claims.uid ? { userId: result.claims.uid } : {}),
        email: result.claims.email,
      };
    } catch {
      // The evaluation already maps a store outage to a verdict; this keeps
      // the plugin-facing contract ("never throws") airtight regardless.
      return null;
    }
  }

  return {
    async hasValidSession(cookieHeader) {
      return (await principalOf(cookieHeader)) !== null;
    },

    sessionPrincipal: principalOf,

    async recordAdminAction(_cookieHeader, entry) {
      log(`[operator-auth] refused unscoped audit write '${entry.action}' (no plugin id)`);
      return false;
    },

    recordForPlugin,
  };

  async function recordForPlugin(
    pluginId: string,
    cookieHeader: string | undefined,
    entry: OperatorAdminAuditEntry,
  ): Promise<boolean> {
    if (!isPluginAuditAllowed(pluginId, entry.action, entry.target)) {
      log(
        `[operator-auth] refused audit action '${entry.action}' from ${pluginId} (not admitted for this plugin/target)`,
      );
      return false;
    }
    if (payloadTooLarge(entry.before) || payloadTooLarge(entry.after)) {
      log(`[operator-auth] refused audit action '${entry.action}' from ${pluginId} (payload too large)`);
      return false;
    }
    const writer = deps.audit?.current;
    if (!writer) return false;
    const principal = await principalOf(cookieHeader);
    if (!principal) return false;
    try {
      await writer.record({
        actor: { id: principal.userId, email: principal.email },
        action: entry.action as AuditAction,
        target: entry.target,
        // The plugin id is stamped LAST into both snapshots, so a plugin can
        // never present itself as another one.
        ...(entry.before ? { before: { ...entry.before, plugin: pluginId } } : {}),
        after: { ...(entry.after ?? {}), plugin: pluginId },
      });
      return true;
    } catch (err) {
      log(
        `[operator-auth] admin_audit write for '${entry.action}' failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}

/**
 * #1329 — the per-plugin view of `ctx.operatorAuth`. Binds audit writes to
 * the plugin's id, which decides what it may write and is stamped into the
 * row. Applied by `createPluginContext`, the one place that knows the calling
 * plugin's id. A non-kernel accessor (tests, older hosts) gets no audit writer.
 */
export function scopeOperatorAuthToPlugin(
  base: OperatorAuthAccessor,
  pluginId: string,
): OperatorAuthAccessor {
  return {
    hasValidSession: (cookie) => base.hasValidSession(cookie),
    ...(base.sessionPrincipal ? { sessionPrincipal: base.sessionPrincipal.bind(base) } : {}),
    ...(isKernelOperatorAuth(base)
      ? {
          recordAdminAction: (cookie, entry) => base.recordForPlugin(pluginId, cookie, entry),
        }
      : {}),
  };
}
