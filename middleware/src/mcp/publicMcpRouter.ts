/**
 * W2-3 (issue #542) — mounts the public MCP server as an express router.
 *
 * Split from `PublicMcpServer` so the protocol/authorization logic is testable
 * without an HTTP stack, and so the WIRING (which middleware, in which order)
 * is one short readable file. The order below is load-bearing:
 *
 *   1. `bodyCapMiddleware` — cheapest rejection, and it must run before any
 *      work is attributed to a key.
 *   2. `requireApiKey`     — authentication + the general per-key rate limit +
 *                            the `mcp:invoke`-class scope floor. Answers 401 on
 *                            a missing/invalid key and 403 on a scope miss.
 *   3. the MCP handler     — per-request stateless transport, per-key allowlist.
 *
 * `requireApiKey` is given NO `scope` option on purpose. A single scope check
 * here would have to be either `mcp:list` or `mcp:invoke`, and whichever were
 * chosen would 403 the other legitimate request shape. Both are checked inside
 * the JSON-RPC handlers, where the method being invoked is known. The 403-on-
 * scope-miss behavior is still exercised — see `requireApiKey`'s own tests and
 * the endpoint tests for the per-method gates.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';

import type { ApiKeyStore, AuditLog, RateLimiter } from '@omadia/api-key-auth';
import { requireApiKey } from '@omadia/api-key-auth';
import { AI_PROVENANCE_HEADER, AI_PROVENANCE_HEADER_VALUE } from '@omadia/channel-sdk';

import { PUBLIC_MCP_PATH } from './publicMcpPath.js';
import { PublicMcpServer, type PublicMcpServerDeps } from './publicMcpServer.js';

/**
 * The router handles its mount root, NOT an absolute path.
 *
 * The caller mounts it at `PUBLIC_MCP_PATH`, so this is `'/'`. Baking the
 * absolute path in here as well would make `app.use(PUBLIC_MCP_PATH, router)`
 * resolve to `/api/v1/mcp/api/v1/mcp` — and the version that "works",
 * `app.use(router)`, would apply the router's own middleware (including
 * `requireAuth`, which the caller pairs it with) to EVERY request on the app.
 */
const ROUTER_ROOT = '/';

/**
 * #647 — AI-Act Art. 50 provenance, envelope level, for the public MCP path.
 *
 * The analogue of the chat API's stream-open header: it marks that responses
 * from this endpoint are served by an omadia AI system (Art. 50 §1 — the caller
 * is interfacing an AI system), independent of what any individual tool result's
 * data is. Set unconditionally on the way IN so it rides every reply the handler
 * writes — a tool result, a JSON-RPC error, a 405/500 — because the transport's
 * `res.writeHead` merges, rather than replaces, headers already set here.
 *
 * Mounted AFTER `requireApiKey`, so an unauthenticated 401 (which is not an AI
 * response) does not carry it. The per-call twin rides the `tools/call` result's
 * `_meta`; see `PublicMcpServer`.
 */
const setProvenanceHeader: RequestHandler = (_req, res, next) => {
  res.setHeader(AI_PROVENANCE_HEADER, AI_PROVENANCE_HEADER_VALUE);
  next();
};

export interface PublicMcpRouterDeps extends PublicMcpServerDeps {
  /** The SAME store the operator mints keys with. Reused rather than
   *  duplicated: a second key store would be a second place to revoke. */
  readonly apiKeys: ApiKeyStore;
  /** General per-key budget, applied by `requireApiKey` to every request
   *  including `tools/list`. Distinct from `writeRateLimiter`. */
  readonly rateLimiter?: RateLimiter;
  /** `@omadia/api-key-auth`'s own vault-backed usage trail. Complementary to
   *  the `mcp_call_log` rows the audit sink writes: this one records HTTP
   *  outcomes per key, that one records tool calls. */
  readonly keyAuditLog?: AuditLog;
}

export function createPublicMcpRouter(deps: PublicMcpRouterDeps): Router {
  const server = new PublicMcpServer(deps);
  const router = Router();

  router.use(
    ROUTER_ROOT,
    server.bodyCapMiddleware(),
    requireApiKey({
      apiKeys: deps.apiKeys,
      ...(deps.rateLimiter ? { rateLimiter: deps.rateLimiter } : {}),
      ...(deps.keyAuditLog ? { auditLog: deps.keyAuditLog } : {}),
      routeLabel: PUBLIC_MCP_PATH,
    }),
    setProvenanceHeader,
    server.handler(),
  );

  return router;
}
