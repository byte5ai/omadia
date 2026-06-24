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
  /** Plugin whose vault namespace + descriptor this flow targets. Always
   *  present — it binds the state (and the resulting tokens) to one plugin
   *  on both the install-drawer and the store-detail re-connect paths. */
  pluginId: string;
  /** Provider-id for routing the callback to the right descriptor. */
  providerId: string;
  /** Plugin-manifest field key the operator is connecting (so we know
   *  where the resulting tokens go). */
  fieldKey: string;
  /** Install-job this flow belongs to. Present only on the first-time
   *  install-drawer path; absent on the store-detail re-connect path (an
   *  installed plugin re-acquiring a revoked credential — no job exists). */
  jobId?: string;
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
  const pluginId =
    typeof payload['pluginId'] === 'string' ? payload['pluginId'] : '';
  const providerId =
    typeof payload['providerId'] === 'string' ? payload['providerId'] : '';
  const fieldKey =
    typeof payload['fieldKey'] === 'string' ? payload['fieldKey'] : '';
  const jobIdRaw = payload['jobId'];
  const jobId =
    typeof jobIdRaw === 'string' && jobIdRaw.length > 0 ? jobIdRaw : undefined;
  if (!flowId || !pluginId || !providerId || !fieldKey) {
    throw new Error('oauth state token missing required claims');
  }
  const claims: OAuthStateClaims = { flowId, pluginId, providerId, fieldKey };
  if (jobId) claims.jobId = jobId;
  return claims;
}
