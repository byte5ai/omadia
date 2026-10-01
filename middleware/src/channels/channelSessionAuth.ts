import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import type { ChannelSessionClaims } from '@omadia/channel-sdk';

import {
  SESSION_COOKIE,
  evaluateSessionToken,
  type SessionEvaluationDeps,
} from '../auth/requireAuth.js';
import {
  SESSION_CHECK_UNAVAILABLE_CODE,
  SESSION_REVOKED_CODE,
} from '../auth/sessionRevocation.js';

import type { WebSocketAuthResult } from './webSocketUpgradeAuth.js';

/**
 * The session cookie of a channel WebSocket: judged at the upgrade, kept
 * beside the socket for the re-checks, and never shown to the plugin handler.
 */

/**
 * An authenticated channel session as the registry holds it. The raw token
 * never leaves the registry; a handler only ever gets `claims`.
 */
export interface AuthenticatedChannelSession {
  readonly claims: ChannelSessionClaims;
  readonly token: string;
  /** Token `exp`, Unix epoch seconds; 0 for a token without one. */
  readonly expiresAt: number;
}

/**
 * The channel-route authenticator: `requireAuth`'s own session evaluation
 * (same signing key, same Entra whitelist gate, same revocation guard), so the
 * WS upgrade and the HTTP gate cannot drift. Status mapping matches
 * `requireAuth`: `auth.not_whitelisted` → 403, a failed revocation lookup →
 * 503 (thrown, so `authenticateBeforeHandshake` answers it as the outage it
 * is), everything else → 401. The raw upgrade request has no cookie-parser
 * middleware in front of it, so the header is parsed by hand.
 *
 * The principal keeps the token and its `exp` for the session tracker; the
 * handler later gets `claims` only.
 */
export async function authenticateChannelSession(
  req: IncomingMessage,
  deps: SessionEvaluationDeps,
): Promise<WebSocketAuthResult<AuthenticatedChannelSession>> {
  const token = sessionTokenFromCookie(req.headers.cookie);
  // No cookie is routine (a reconnecting signed-out tab) and stays unlogged.
  if (token === undefined) return { ok: false, status: 401 };
  const result = await evaluateSessionToken(token, deps);
  if (!result.ok) {
    if (result.code === SESSION_CHECK_UNAVAILABLE_CODE) {
      throw new Error('session revocation lookup unavailable');
    }
    // Missing/expired cookies are routine (a reconnecting logged-out tab)
    // and stay unlogged. A de-whitelisted identity is worth a log line, and
    // so is a revoked session: that cookie outlived a sign-out or a reset.
    if (result.code === 'auth.not_whitelisted') {
      return { ok: false, status: 403, message: result.code };
    }
    return result.code === SESSION_REVOKED_CODE
      ? { ok: false, status: 401, message: result.code }
      : { ok: false, status: 401 };
  }
  const verified = result.claims;
  return {
    ok: true,
    principal: {
      token,
      expiresAt: verified.exp,
      claims: {
        subject: verified.sub,
        email: verified.email,
        displayName: verified.display_name,
        provider: verified.provider,
        ...(verified.omadia_user_id ? { omadiaUserId: verified.omadia_user_id } : {}),
        expiresAt: verified.exp,
      },
    },
  };
}

/** Extract the session cookie value from a raw `Cookie` header. */
function sessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // A malformed %-escape is not a token we minted; verification rejects it.
        return raw;
      }
    }
  }
  return undefined;
}

/**
 * The upgrade request's headers minus the session cookie, for handlers: they
 * get the verified claims, never the token. Other cookies pass through.
 */
export function withoutSessionCookie(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { cookie, ...rest } = headers;
  if (cookie === undefined) return rest;
  const kept = cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && cookieName(pair) !== SESSION_COOKIE);
  return kept.length > 0 ? { ...rest, cookie: kept.join('; ') } : rest;
}

function cookieName(pair: string): string {
  const eq = pair.indexOf('=');
  return (eq === -1 ? pair : pair.slice(0, eq)).trim();
}
