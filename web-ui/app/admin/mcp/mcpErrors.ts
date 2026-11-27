import { ApiError } from '../../_lib/api';

/**
 * Pure error classifiers for the MCP admin page (issues #1341 / #1342).
 *
 * They live outside `page.tsx` because a Next.js page module may only export
 * the page itself, and these need to be unit-testable on their own.
 */

/**
 * The `message` field of an ApiError's JSON body, or `null` when the body is
 * not JSON or carries no usable message. `ApiError.message` itself is only the
 * client's generic status line ("POST … failed: 502"); the route's explanation
 * of *why* lives in the body.
 */
export function apiErrorBodyMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { message?: unknown };
    return typeof parsed.message === 'string' && parsed.message.trim().length > 0
      ? parsed.message
      : null;
  } catch {
    return null;
  }
}

/**
 * Refusals by the middleware's outbound guard. Neither one is transient: the
 * same URL or the same stdio server is refused again on every retry, so the UI
 * explains the rule instead of offering to try again.
 */
export type McpGuardCode = 'blocked_host' | 'stdio_disabled' | 'stdio_isolation_unavailable';

const GUARD_CODES: ReadonlySet<string> = new Set<McpGuardCode>([
  'blocked_host',
  'stdio_disabled',
  // #2306 — MCP_STDIO_RUN_AS is set but the user switch fails (fail closed).
  'stdio_isolation_unavailable',
]);

export function mcpGuardCode(err: unknown): McpGuardCode | null {
  if (!(err instanceof ApiError) || typeof err.code !== 'string') return null;
  return GUARD_CODES.has(err.code) ? (err.code as McpGuardCode) : null;
}

/**
 * Classify a catalog failure into the things an operator can actually do
 * something about. `code` comes from the route's JSON body (`McpRegistryError`
 * codes), so this stays a lookup rather than message-sniffing.
 *
 * The distinction is not cosmetic: "the host never answered" (the official
 * registry black-holing packets) needs a different reaction — pick another
 * registry — than "the registry answered with something unparseable", and a
 * `blocked_host` refusal can never be fixed by retrying at all.
 */
export type CatalogErrorKind = 'timeout' | 'unreachable' | 'blocked' | 'generic';

export function catalogErrorKind(err: unknown): CatalogErrorKind {
  if (!(err instanceof ApiError)) return 'generic';
  if (err.code === 'timeout') return 'timeout';
  if (err.code === 'blocked_host') return 'blocked';
  // Only genuinely transport-level codes claim "unreachable". `http_error` /
  // `bad_catalog_shape` mean the registry answered badly, which is a different
  // problem with a different remedy.
  if (err.code === 'transport_failed') return 'unreachable';
  return 'generic';
}

/**
 * W09-10 — MCP route refusals that carry their meaning in `error` (#1917,
 * #1924, #1933, #1948). The middleware's `message` is English; the UI shows
 * the catalog copy under `adminMcp.routeErrors.<key>` instead.
 */
export type McpRouteErrorKey =
  | 'toolListEmpty'
  | 'oauthDiscoveryFailed'
  | 'delegationConfirmationRequired'
  | 'toolNameCollision';

export function mcpRouteErrorKey(err: unknown): McpRouteErrorKey | null {
  if (!(err instanceof ApiError)) return null;
  let body: { error?: unknown; message?: unknown };
  try {
    body = JSON.parse(err.body) as { error?: unknown; message?: unknown };
  } catch {
    return null;
  }
  if (body.error === 'mcp_tool_list_empty') return 'toolListEmpty';
  if (body.error === 'mcp_oauth_discovery_failed') return 'oauthDiscoveryFailed';
  if (body.error === 'delegation_confirmation_required') return 'delegationConfirmationRequired';
  if (typeof body.message === 'string' && body.message.startsWith('mcp_tool_name_collision:')) {
    return 'toolNameCollision';
  }
  return null;
}
