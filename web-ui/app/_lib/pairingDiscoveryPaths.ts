/**
 * Pairing-discovery paths on the operator origin (#293), shared by the
 * `next.config.ts` rewrite and the login gate in `proxy.ts`.
 *
 * One definition, so the rewrite and the gate's exemption cannot drift apart.
 * The middleware keeps its public paths the same way (`CIMD_METADATA_PATH`,
 * `PUBLIC_MCP_PATH` in `middleware/src/auth/publicPaths.ts`). A drifted copy
 * fails quietly: the rewrite still routes, but the gate bounces the
 * cookie-less desktop client to `/login`.
 *
 * Leaf module with no imports: `next.config.ts` loads it at build time,
 * outside the app's module graph.
 */

/** Canonical public path. Must equal the middleware's `WELL_KNOWN_PATH`
 *  (`middleware/src/pairing/discovery.ts`), so a client finds the descriptor
 *  at the same path on either origin. */
export const PAIRING_DISCOVERY_WELL_KNOWN_PATH = '/.well-known/omadia-ui';

/** The route handler that serves it (`app/pairing-discovery/route.ts`),
 *  reached through the `next.config.ts` rewrite. */
export const PAIRING_DISCOVERY_HANDLER_PATH = '/pairing-discovery';
