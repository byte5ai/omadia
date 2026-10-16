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
export type McpGuardCode = 'blocked_host' | 'stdio_disabled';

export function mcpGuardCode(err: unknown): McpGuardCode | null {
  if (!(err instanceof ApiError)) return null;
  return err.code === 'blocked_host' || err.code === 'stdio_disabled' ? err.code : null;
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
