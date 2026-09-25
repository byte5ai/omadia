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
  /** Slice 1b-channel-web — Omadia-Identity cluster root for this user
   *  in the knowledge graph. Resolved at login via
   *  `kg.resolveOrCreateChannelIdentity({channelKind: 'web', …})` and
   *  cached so chat requests skip the round-trip. Optional: (a) old
   *  tokens predate the field, (b) bootstrap may disable cluster
   *  resolution when no `knowledgeGraph` capability is wired (tests,
   *  kg-shell-only deployments). Consumers MUST treat absence as "no
   *  cluster yet", never "cookie invalid". */
  omadia_user_id?: string;
  /** #965 — time of the ORIGINAL authentication, Unix epoch **seconds**
   *  (OIDC `auth_time` semantics). Unlike `iat` it survives re-minting on
   *  `POST /api/v1/auth/renew`, which is what lets the renewal chain be
   *  bounded by an absolute cap. Optional on input: `signSession` stamps
   *  "now" when absent (every login path); renewal passes the old value on. */
  auth_time?: number;
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
  /** Original authentication time — Unix epoch **seconds**. Tokens minted
   *  before #965 carry no `auth_time`; for those it falls back to `iat`
   *  (the moment that pre-renewal token was minted by a real login). */
  auth_time: number;
}

/**
 * Sign a session token. Default lifetime is the 4h access window from the
 * plan; callers can override for short-lived side-channel tokens (e.g. the
 * PKCE verifier cookie).
 *
 * `expiresIn` follows jose's `setExpirationTime`: a string is a duration
 * relative to now ('4h', '14400s'), a number is an ABSOLUTE Unix epoch in
 * seconds — the renewal path uses the latter to clamp `exp` to the
 * absolute cap.
 *
 * `auth_time` is stamped with "now" unless the caller carries one over.
 */
export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  expiresIn: string | number = '4h',
): Promise<string> {
  const payload: SessionClaims = {
    ...claims,
    auth_time: claims.auth_time ?? Math.floor(Date.now() / 1000),
  };
  return await new SignJWT(payload as unknown as Record<string, unknown>)
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
  const omadiaUserId =
    typeof payload['omadia_user_id'] === 'string' &&
    payload['omadia_user_id'].length > 0
      ? payload['omadia_user_id']
      : undefined;
  // #965 — legacy tokens (minted before `auth_time` existed) treat `iat`
  // as the authentication time: they were minted by a real login, never by
  // a renewal, so `iat` IS their first-login moment.
  const authTime =
    typeof payload['auth_time'] === 'number' &&
    Number.isFinite(payload['auth_time'])
      ? payload['auth_time']
      : iat;
  if (!sub || !email || !role) {
    throw new Error('session token missing required claims');
  }
  return {
    sub,
    email,
    display_name: displayName,
    role,
    provider,
    ...(omadiaUserId ? { omadia_user_id: omadiaUserId } : {}),
    exp,
    iat,
    auth_time: authTime,
  };
}
