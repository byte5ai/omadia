/**
 * The `omadia_session` cookie and its decode-only freshness check.
 *
 * Shared by the edge proxy (which bounces a stale cookie to /login) and the
 * root layout (which renders the minimal signed-out header when there is no
 * fresh session). Decode-only on purpose: no signature verification here —
 * the backend's `requireAuth` is the authoritative check on every API call.
 * This only answers "does the browser hold something that looks like a live
 * session", which is all either caller needs.
 */

export const SESSION_COOKIE = 'omadia_session';

/**
 * Decode the JWT payload (no signature verification) and check the `exp`
 * claim. Returns true if the token is malformed or already expired — in
 * either case callers treat it as no-session.
 */
export function isJwtExpiredOrMalformed(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return true;
  const payloadSegment = parts[1];
  if (!payloadSegment) return true;
  try {
    const b64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

/** True when `value` is a present, well-formed, unexpired session token. */
export function isFreshSessionToken(value: string | undefined): boolean {
  return Boolean(value) && !isJwtExpiredOrMalformed(value as string);
}
