import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS512';
const ISSUER = 'omadia';

export interface SessionClaims {
  /** Stable per-user identifier within the issuing provider. For 'local'
   *  this equals the lower-cased email; for OIDC providers it's the IdP
   *  `sub`/`oid`. Combined with `provider` it forms the unique identity. */
  sub: string;
  email: string;
  display_name: string;
  /** Provider id this session was minted by ('local' | 'entra' | future
   *  plugin id). Required since OB-49 — older tokens without it fall back
   *  to 'entra' for backward-compatibility, since pre-OB-49 sessions only
   *  came from the hard-coded Azure-AD path. */
  provider: string;
  /** Whitelist label — currently always 'admin' until roles split. */
  role: 'admin';
}

/**
 * The result of verifying a session token: the signed identity claims plus
 * the JWT registered timestamps. `exp`/`iat` are intentionally NOT part of
 * `SessionClaims` because that type doubles as the *input* to
 * `signSession`, which mints those timestamps itself. Identity-only callers
 * keep using `SessionClaims`; expiry-aware paths (GET /me, the UI session
 * watcher) read `exp` to drive the visible countdown / auto-logout.
 */
export interface VerifiedSession extends SessionClaims {
  /** Expiry — Unix epoch **seconds** (JWT `exp`). */
  exp: number;
  /** Issued-at — Unix epoch **seconds** (JWT `iat`). */
  iat: number;
}

/**
 * Sign a session token. Default lifetime is the 4h access window from the
 * plan; callers can override for short-lived side-channel tokens (e.g. the
 * PKCE verifier cookie).
 */
export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  expiresIn: string = '4h',
): Promise<string> {
  return await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

export async function verifySession(
  token: string,
  key: Uint8Array,
): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    algorithms: [ALG],
  });
  // `jwtVerify` already rejects an expired token; these reads only surface
  // the timestamps for callers. Both are always present on tokens minted
  // by `signSession` (it sets iat + expiration), but narrow defensively.
  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : 0;
  const iat = typeof payload['iat'] === 'number' ? payload['iat'] : 0;
  const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
  const email = typeof payload['email'] === 'string' ? payload['email'] : '';
  const displayName =
    typeof payload['display_name'] === 'string'
      ? payload['display_name']
      : '';
  const role = payload['role'] === 'admin' ? 'admin' : null;
  // Backward-compat: pre-OB-49 sessions don't carry `provider`. Default
  // to 'entra' there since that was the only minting path. Re-login then
  // upgrades the cookie to a current-shape one on next /login.
  const provider =
    typeof payload['provider'] === 'string' && payload['provider'].length > 0
      ? payload['provider']
      : 'entra';
  if (!sub || !email || !role) {
    throw new Error('session token missing required claims');
  }
  return {
    sub,
    email,
    display_name: displayName,
    role,
    provider,
    exp,
    iat,
  };
}
