/**
 * #1936 — one entry in the API key's usage log per authenticated public MCP
 * request.
 *
 * `requireApiKey` records only the outcomes it produces itself (`rate_limited`,
 * `forbidden`); a route handler reports everything else through
 * `principal.audit`. The public MCP endpoint answers most failures as JSON-RPC
 * errors inside an HTTP 200, so the HTTP status alone cannot tell a refused
 * tool call from a served one. The tracker collects the outcome the server
 * itself decided while handling the request and writes it once when the
 * response is finished.
 *
 * The `mcp_call_log` row stays the per-call record; this entry is what lets
 * `/admin/api-keys` show "last used" for a key that is only used over MCP.
 */

import type { Response } from 'express';

import type { ApiKeyPrincipal, AuditStatus } from '@omadia/api-key-auth';

/** Higher wins when one request produces several outcomes. */
const SEVERITY: Readonly<Record<AuditStatus, number>> = {
  ok: 0,
  error: 1,
  invalid_request: 2,
  rate_limited: 3,
  forbidden: 4,
};

/** `mcp_call_log` reasons that are a refusal of the key, not a failure. */
const FORBIDDEN_REASONS: ReadonlySet<string> = new Set([
  'no public MCP binding',
  'not allowlisted',
]);

/** The usage-log status for one recorded call. */
export function usageStatusForCall(ok: boolean, reason: string | null): AuditStatus {
  if (ok) return 'ok';
  if (reason !== null && FORBIDDEN_REASONS.has(reason)) return 'forbidden';
  if (reason === 'write rate limited') return 'rate_limited';
  return 'error';
}

function statusForHttp(statusCode: number, decided: AuditStatus): AuditStatus {
  if (statusCode >= 500) return 'error';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 400) return 'invalid_request';
  return decided;
}

export interface PublicMcpUsageTracker {
  /** Remember an outcome of this request; the most severe one is written. */
  note(principal: ApiKeyPrincipal, status: AuditStatus): void;
  /** Start tracking one request; writes its entry when `res` finishes. */
  track(principal: ApiKeyPrincipal, res: Response): void;
}

/**
 * Keyed by the principal object, which `requireApiKey` builds fresh for every
 * request, so two concurrent requests of one key never share an outcome.
 */
export function createPublicMcpUsageTracker(): PublicMcpUsageTracker {
  const decided = new WeakMap<ApiKeyPrincipal, AuditStatus>();

  return {
    note(principal, status) {
      const current = decided.get(principal);
      if (current === undefined) return;
      if (SEVERITY[status] > SEVERITY[current]) decided.set(principal, status);
    },
    track(principal, res) {
      decided.set(principal, 'ok');
      let written = false;
      const write = (): void => {
        if (written) return;
        written = true;
        const status = statusForHttp(res.statusCode, decided.get(principal) ?? 'ok');
        decided.delete(principal);
        try {
          principal.audit(status);
        } catch (err) {
          // Fire-and-forget by contract; a throwing sink must not surface here.
          console.warn(`[public-mcp] usage log write threw: ${String(err)}`);
        }
      };
      res.once('finish', write);
      // A client that drops the connection gets no `finish`; it still used the key.
      res.once('close', write);
    },
  };
}
