/**
 * Failure vocabulary of the operator memory-contexts endpoint.
 *
 * Pure so the page stays a rendering concern and the mapping can be reasoned
 * about on its own: what the browser SAYS about a non-200 is the whole
 * usefulness of an operator surface that cannot show the data.
 */

/**
 * Catalog key (inside the `memory` namespace) for a non-OK answer, or null when
 * the status has no dedicated story and the generic message should be used.
 *
 * 401 and 403 are ORDINARY answers on a `requireAuth`-gated route, so they get
 * their own copy. Before the browser moved off the dev endpoint its only
 * non-200 stories were "dev endpoint missing" and "upstream error page"; under
 * the operator endpoint an expired session would have rendered as a bare
 * "Listing failed (HTTP 401)", which tells an operator nothing about how to
 * recover.
 */
export interface MemoryErrorContext {
  /** The requested path IS `/memories/contexts` itself. */
  readonly atContextsRoot?: boolean;
  /** The body is the router's own `{"error":"not_found"}` JSON. `false` means
   *  the 404 was produced somewhere in FRONT of the route. */
  readonly isRouterNotFound?: boolean;
}

export function memoryErrorKey(
  status: number,
  looksHtml: boolean,
  context: MemoryErrorContext = {},
): string | null {
  if (status === 401) return 'errorUnauthenticated';
  if (status === 403) return 'errorForbidden';
  if (status === 404) {
    // A MOUNTED router cannot answer 404 for the contexts ROOT: it skips the
    // exists-check when the resolved relative path is empty
    // (`middleware/src/routes/operatorMemoryContexts.ts`). So a 404 there is
    // never "the path is gone" — it is "the route is not reachable", most
    // likely because the operator memory router was not mounted. Saying
    // "this path no longer exists" would tell an operator their store is
    // empty when the endpoint is simply missing.
    if (context.atContextsRoot === true) return 'errorEndpointUnreachable';
    // Same conclusion from the other direction: a 404 that is not the
    // router's own JSON came from a proxy or the framework, not the route.
    if (context.isRouterNotFound === false) return 'errorEndpointUnreachable';
    return 'errorPathNotFound';
  }
  // #667 — a 500 means something ANSWERED, so "middleware unreachable" is an
  // assertion this code never checked; say the fault is server-side instead.
  if (status === 500 && looksHtml) return 'errorUpstreamErrorPage';
  return null;
}

/** True when a body is the router's own `{ "error": "not_found" }`. Anything
 *  else behind a 404 was produced in front of the route. */
export function isRouterNotFoundBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { error?: unknown }).error === 'not_found'
    );
  } catch {
    return false;
  }
}

/**
 * True when a response body is a proxy/framework error PAGE rather than the
 * router's own JSON — the signal that the status came from somewhere between
 * the browser and the route.
 */
export function looksLikeErrorPage(contentType: string, body: string): boolean {
  return (
    contentType.includes('text/html') ||
    body.trimStart().toLowerCase().startsWith('<!doctype')
  );
}
