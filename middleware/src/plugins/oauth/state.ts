/**
 * Signed-state helper for the plugin-OAuth flow (HANDOFF §5.6).
 *
 * The OAuth `state` query-param serves three jobs simultaneously:
 *  1. CSRF token (verified on the callback before we trust the code)
 *  2. Provider router (callback resolves which factory to instantiate)
 *  3. Flow lookup key (links callback back to its pendingFlows entry)
 *
 * We pack all three into a short-lived (10-min) signed JWT using the same
 * symmetric key as session cookies — that key is already
 * vault-persisted + machine-stable (`auth/sessionSigningKey.ts`). No
 * separate key rotation needed.
 *
 * Audience claim ('plugin-oauth') keeps these tokens disjoint from
 * login-session tokens that share the signing key but live under
 * audience-less issuance — verifyOAuthState() rejects any JWT that
 * doesn't carry the right audience.
 */

import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS512';
const ISSUER = 'omadia';
const AUDIENCE = 'plugin-oauth';
const DEFAULT_TTL = '10m';

export interface OAuthStateClaims {
  /** Server-side pendingFlows key. */
  flowId: string;
  /** Install-job this flow belongs to. */
  jobId: string;
  /** Provider-id for routing the callback to the right factory. */
  providerId: string;
  /** Plugin-manifest field key the operator is connecting (so we know
   *  where in the install-job's secret-buffer the tokens go). */
  fieldKey: string;
}

export async function signOAuthState(
  claims: OAuthStateClaims,
  key: Uint8Array,
  expiresIn: string = DEFAULT_TTL,
): Promise<string> {
  return await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

export async function verifyOAuthState(
  token: string,
  key: Uint8Array,
): Promise<OAuthStateClaims> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [ALG],
  });
  const flowId = typeof payload['flowId'] === 'string' ? payload['flowId'] : '';
  const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : '';
  const providerId =
    typeof payload['providerId'] === 'string' ? payload['providerId'] : '';
  const fieldKey =
    typeof payload['fieldKey'] === 'string' ? payload['fieldKey'] : '';
  if (!flowId || !jobId || !providerId || !fieldKey) {
    throw new Error('oauth state token missing required claims');
  }
  return { flowId, jobId, providerId, fieldKey };
}
