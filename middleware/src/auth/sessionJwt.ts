import { randomUUID } from 'node:crypto';

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
  /** Server-side session revocation — the account's `users.session_version`
   *  at mint time. `evaluateSessionToken` refuses the token once the row has
   *  moved past it (sign-out, admin password reset, disable). Optional on
   *  input: `signSession` stamps 0 when absent. Renewal carries it over. */
  sv?: number;
  /** Random id of this sign-in, minted by `signSession` when absent and
   *  carried over on renewal. Nothing checks it yet: it exists so a later
   *  per-sign-in revocation (one device instead of every device) or a
   *  live-socket close can key off one session without a re-mint cycle. */
  sid?: string;
  /** `users.id` of the account at mint time. Binds the token to one
   *  incarnation of the row: a user deleted and re-created under the same
   *  identity gets a new id, so a cookie minted for the old row stays dead
   *  even though the new row starts at version 0 again. */
  uid?: string;
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
  /** Session version the token was minted at. Tokens minted before the claim
   *  existed read as version 0 — the value every existing row starts at — so
   *  they stay valid until that user's sessions are first revoked. */
  sv: number;
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
 * `auth_time` is stamped with "now" unless the caller carries one over, `sv`
 * defaults to 0 and `sid` to a fresh random id (every login path); renewal
 * passes all three on.
 */
export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  expiresIn: string | number = '4h',
): Promise<string> {
  const payload: SessionClaims = {
    ...claims,
    auth_time: claims.auth_time ?? Math.floor(Date.now() / 1000),
    sv: claims.sv ?? 0,
    sid: claims.sid ?? randomUUID(),
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
  // Server-side revocation: a token minted before `sv` existed is version 0.
  const sv =
    typeof payload['sv'] === 'number' && Number.isSafeInteger(payload['sv'])
      ? payload['sv']
      : 0;
  const sid =
    typeof payload['sid'] === 'string' && payload['sid'].length > 0
      ? payload['sid']
      : undefined;
  const uid =
    typeof payload['uid'] === 'string' && payload['uid'].length > 0
      ? payload['uid']
      : undefined;
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
    sv,
    ...(sid ? { sid } : {}),
    ...(uid ? { uid } : {}),
  };
}
