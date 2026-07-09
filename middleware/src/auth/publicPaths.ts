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
  // routes/devRunnerApi.ts — that IS its authentication.
  /^\/api\/v1\/dev-runner(?:\/|$|\?)/,
  // Plugin-served UI surfaces (`/p/<pluginId>/...`), iframed by Teams where
  // only a Teams SSO token exists. Plugins exposing sensitive data validate
  // that token themselves.
  /^\/p\/[^/]+(?:\/|$|\?)/,
];

/**
 * `/api/dev/*` is public only while `DEV_ENDPOINTS_ENABLED=true`, and those
 * routes are not mounted at all otherwise — so the bypass cannot leak.
 */
export function publicPaths(opts: { devEndpointsEnabled: boolean }): readonly RegExp[] {
  return opts.devEndpointsEnabled
    ? [...STATIC_PUBLIC_PATHS, /^\/api\/dev(?:\/|$|\?)/]
    : STATIC_PUBLIC_PATHS;
}
