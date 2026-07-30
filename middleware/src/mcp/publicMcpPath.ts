/**
 * W2-3 (issue #542) — the ONE definition of the public MCP endpoint's path.
 *
 * Its own module, dependency-free on purpose. `auth/publicPaths.ts` imports it
 * to build the requireAuth exemption, and `index.ts` imports it to mount the
 * router; if this constant lived next to the server implementation, importing
 * it would drag the MCP SDK into `publicPaths.ts`'s import graph (and into
 * every test that asserts against the allowlist) for the sake of one string.
 *
 * The reason it is a shared constant at all is recorded at the top of
 * `auth/publicPaths.ts`: epic #470's runner router was mounted without a
 * session guard and its e2e test built a bare `express()` app to prove it, so
 * the test passed while the route 401'd in production behind the blanket `/api`
 * guard. A retyped path is that same bug with a different name.
 */

/** Where the public, stateless, API-key-authenticated MCP server is mounted. */
export const PUBLIC_MCP_PATH = '/api/v1/mcp';

/**
 * Denormalized `server_name` for the `mcp_call_log` rows this endpoint writes.
 *
 * Public MCP calls have no upstream MCP server — omadia IS the server here, and
 * the call goes inward to a local tool rather than outward to a vendor. The
 * `server_id` FK stays NULL (0009 made it nullable precisely so audit rows
 * survive without a server row) and this literal is what an operator sees in
 * the call-log UI's Server column.
 */
export const PUBLIC_MCP_SERVER_NAME = 'omadia-public-mcp';
