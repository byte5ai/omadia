/**
 * Which identity an MCP call acts as (W0-1, D2) — the confused-deputy fix.
 *
 * Before this, both the operator router and the runtime McpManager resolved the
 * OAuth user key as `<something> ?? 'operator'`. That fallback is the bug: a
 * Teams or Telegram turn whose user has no mapped identity would silently reach
 * the customer's MCP server holding the OPERATOR's token — full operator
 * authority, granted to whoever happened to be typing in a channel.
 *
 * Resolution is now explicit and per server:
 *
 *   delegation = 'service'   one shared identity, deliberately opted into. The
 *                            key stays `operator`, so servers grandfathered by
 *                            migration 0031 keep the token they already have.
 *
 *   delegation = 'per_user'  the caller's own identity or nothing. An
 *                            unresolvable identity yields `null`, the caller
 *                            gets no token, and the call fails closed through
 *                            the existing `onAuthFailure` path.
 *
 * There is deliberately no third branch. Every path that needs a user key goes
 * through `resolveMcpUserKey`, so the fallback cannot reappear by accident.
 */

import type { McpDelegation, McpServerRow } from '@omadia/orchestrator';

/** The shared key used when a server opts into `service` delegation. Matches
 *  the historical literal so pre-0031 stored tokens keep resolving. */
export const SERVICE_USER_KEY = 'operator';

/** Recorded in the audit trail when a `per_user` server had no identity to act
 *  as. A row that simply said nothing would hide exactly the case operators
 *  need to find. */
export const UNRESOLVED_IDENTITY = 'unresolved';

/** Just the delegation-relevant slice of a server row, so callers (and tests)
 *  need not build a whole `McpServerRow`. */
export interface DelegationTarget {
  readonly delegation: McpDelegation;
}

/**
 * The identity this call acts as, or `null` when a `per_user` server has no
 * resolvable caller.
 *
 * @param server     the target server (its `delegation` mode decides).
 * @param candidate  the caller's own identity — a session `sub`/`email`, or the
 *                   turn context's `mcpUserKey`. Blank/whitespace counts as
 *                   absent.
 * @param serviceKey the shared key for `service` delegation. Defaults to the
 *                   historical `operator` literal so grandfathered tokens keep
 *                   resolving; only override it in tests.
 */
export function resolveMcpUserKey(
  server: DelegationTarget,
  candidate: string | null | undefined,
  serviceKey: string = SERVICE_USER_KEY,
): string | null {
  if (server.delegation === 'service') return serviceKey;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/** The identity to write to `mcp_call_log`. Never null-by-omission: an
 *  unattributable call is recorded AS unattributable. */
export function auditIdentity(
  server: DelegationTarget,
  candidate: string | null | undefined,
  serviceKey: string = SERVICE_USER_KEY,
): string {
  return resolveMcpUserKey(server, candidate, serviceKey) ?? UNRESOLVED_IDENTITY;
}

/** Operator-facing explanation when a `per_user` server has no caller identity.
 *  Returned through `onAuthFailure`, so the turn fails closed with a reason
 *  instead of silently borrowing the operator's authority. */
export function delegationBlockedMessage(serverName: string): string {
  return (
    `🔒 The MCP server "${serverName}" is set to per-user delegation, but this conversation has no ` +
    `mapped user identity, so there is no one to act as. Nothing was sent to the server. ` +
    `Either sign in through a channel that maps your identity, or have an operator switch this ` +
    `server to a shared service identity in the MCP Control Center.`
  );
}

/** Narrow an untrusted string to a delegation mode. */
export function parseDelegation(value: unknown): McpDelegation | null {
  return value === 'per_user' || value === 'service' ? value : null;
}

/** Convenience for callers that hold a full row. */
export function serverDelegation(server: Pick<McpServerRow, 'delegation'>): McpDelegation {
  return server.delegation;
}
