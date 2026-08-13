/**
 * The `/api` requireAuth mount (OB-106, index.ts) runs for EVERY `/api/*`
 * request, whichever router ultimately answers it. Anything mounted under
 * `/api` that authenticates itself — a webhook with its own JWT, a runner with
 * a one-time job token — must therefore be listed here, or it 401s before its
 * handler is ever reached.
 *
 * This list lives in its own module for one reason: tests must assert against
 * the SAME array production runs. Epic #470's runner router was mounted without
 * a session guard and its e2e test built a bare express() app to prove it — so
 * the test passed while `/api/v1/dev-runner` 401'd in production behind the
 * blanket guard. A shared constant makes that class of drift impossible.
 */

import { CIMD_METADATA_PATH } from '../services/mcpCimd.js';
import { PUBLIC_MCP_PATH } from '../mcp/publicMcpPath.js';

/** Escape a literal path for embedding in a RegExp, so the shared constant —
 *  not a hand-retyped pattern — is what the allowlist actually matches. */
function pathPrefixPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\?)`);
}

/** Public paths that are constant regardless of configuration. */
export const STATIC_PUBLIC_PATHS: readonly RegExp[] = [
  /^\/api\/v1\/auth(?:\/|$|\?)/,
  /^\/api\/v1\/setup(?:\/|$|\?)/,
  /^\/api\/auth(?:\/|$|\?)/,
  // Spec 005 — kernel OAuth broker callback. The IdP redirects the operator's
  // browser back here after consent; the session cookie may have lapsed during
  // the round-trip, so the route self-secures via the signed, single-use
  // `state` token. `/oauth/start` is NOT listed — it stays behind the gate.
  /^\/api\/v1\/install\/oauth\/callback(?:\/|$|\?)/,
  // Bot Framework webhook for channel-teams: the adapter validates the
  // Bot-issued JWT inside the handler; Teams never sends a session cookie.
  /^\/api\/messages(?:\/|$|\?)/,
  // Epic #470 — the dev-platform runner phone-home router. A runner is a
  // process, not an operator: it holds a one-time job token and no session
  // cookie. Every request is authenticated against the job-token hash in
  // devplatform/routes/devRunnerApi.ts — that IS its authentication.
  /^\/api\/v1\/dev-runner(?:\/|$|\?)/,
  // Epic #470 — GitHub redirects finish the dev-platform GitHub-App setup on a
  // signed state token / installation ownership check, not on an operator session.
  /^\/api\/v1\/dev-platform\/github-app\/(?:callback|setup)(?:\/|$|\?)/,
  // Epic #459 W9 — generic MCP-server OAuth callback (bugfix). Same shape as
  // the spec-005 kernel OAuth broker callback above: the provider (Notion,
  // etc.) redirects the operator's browser back here after consent, and the
  // session cookie may be absent or expired by the time the round-trip
  // completes. The route self-secures via the signed, single-use `state`
  // param (see completeAuthorization in agentBuilder.ts) — it was simply
  // never added to this list when the feature shipped, so it 401'd before
  // ever reaching the handler that validates that state token.
  /^\/api\/v1\/operator\/mcp-oauth\/callback(?:\/|$|\?)/,
  // W2-4 (issue #546) — the MCP Client ID Metadata Document. An authorization
  // server fetches this with no credential of ours (the whole point: the
  // `client_id` we hand it IS this URL, which it dereferences), so it must never
  // sit behind an operator session. It carries no secret — only the redirect URI
  // and a display name, both of which the IdP already sees during the authorize
  // round-trip. Built from the SHARED `CIMD_METADATA_PATH` constant rather than
  // a hand-written regex, for the reason in this module's doc comment above:
  // the express route and this allowlist must be incapable of drifting.
  pathPrefixPattern(CIMD_METADATA_PATH),
  // Plugin-served UI surfaces (`/p/<pluginId>/...`), iframed by Teams where
  // only a Teams SSO token exists. Plugins exposing sensitive data validate
  // that token themselves.
  /^\/p\/[^/]+(?:\/|$|\?)/,
  // Issue #438 — the public API channel's chat ingress. A caller presents a
  // per-key API key (Authorization: Bearer) instead of a session cookie; the
  // `@omadia/channel-api` plugin mounts `requireApiKey` from
  // `@omadia/api-key-auth` (issue #439 — constant-time hash compare, per-key
  // rate limit, `chat:write` scope) on this route, and that IS its
  // authentication.
  // Deliberately narrow to `/chat` only: the sibling `/admin/keys` key-
  // lifecycle routes under the same `/api/public/v1` prefix are NOT listed
  // here, so they stay behind this same session gate like every other admin
  // surface (see `src/routes/adminSettings.ts`).
  // NOTE for whoever mounts `requireApiKey` next: an API-key-authenticated
  // route needs an entry here to be reachable at all, and every entry is a
  // new unauthenticated-until-the-handler-says-otherwise surface. Add the
  // narrowest regex that covers the one route, never a prefix that also
  // catches its siblings.
  /^\/api\/public\/v1\/chat(?:\/|$|\?)/,
  // W2-3 (issue #542) — the public, stateless MCP endpoint. Follows the NOTE
  // directly above to the letter: built from the SHARED `PUBLIC_MCP_PATH`
  // constant (so the express mount and this allowlist cannot drift), and via
  // `pathPrefixPattern`, which anchors on `$` or `?` and therefore matches the
  // ONE path — not `/api/v1/mcp/anything` and not a sibling like
  // `/api/v1/mcp-servers`. No regex bypass, no prefix that catches neighbours.
  //
  // Its authentication is `requireApiKey` from `@omadia/api-key-auth`, mounted
  // by `mcp/publicMcpRouter.ts`. That is necessary but NOT the whole gate: the
  // key must additionally hold `mcp:list`/`mcp:invoke` (and the exact
  // `mcp:write:<tool>` for a write), AND have an enabled
  // `public_mcp_key_bindings` row naming the one agent and the exact tools it
  // reaches. A key with no row authenticates and reaches nothing.
  pathPrefixPattern(PUBLIC_MCP_PATH),
];

/**
 * The allowlist `requireAuth` runs against.
 *
 * Issue #669 — this used to take `{ devEndpointsEnabled }` and append
 * `/^\/api\/dev(?:\/|$|\?)/` when the flag was on. The reasoning recorded here
 * was "those routes are not mounted at all otherwise — so the bypass cannot
 * leak", which answers the wrong question: the leak was never a *stale* entry,
 * it was the entry doing exactly what it said while the flag was on. One
 * boolean turned knowledge-graph state and three destructive maintenance
 * sweeps (`POST /api/dev/graph/lifecycle/run-{decay,gc,access-flush}`) into
 * an anonymous surface on any internet-reachable deployment — confirmed with
 * uncredentialed `200`s against a real one.
 *
 * So there is no config-dependent entry any more. `/api/dev/*` is behind the
 * same session gate as every other `/api` route, and the operator surfaces
 * that were trapped behind that flag moved to `/api/v1/admin/kg-*` (see
 * `routes/graphRouterMounts.ts`).
 *
 * Kept as a function, not re-exported as the array, so the ONE production
 * mount and every test keep going through a single accessor — the drift this
 * module's doc comment above exists to prevent.
 */
export function publicPaths(): readonly RegExp[] {
  return STATIC_PUBLIC_PATHS;
}
