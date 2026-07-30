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

import type { ApiKeyStore, AuditLog, RateLimiter } from '@omadia/api-key-auth';
import { requireApiKey } from '@omadia/api-key-auth';

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
    server.handler(),
  );

  return router;
}
