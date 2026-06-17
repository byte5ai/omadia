/**
 * Spec 004 (FR-B3) — generic, plugin-audience-bound state token for the
 * `ctx.flows` toolkit.
 *
 * A plugin running its own redirect flow (the GitHub App-Manifest dance, a
 * device flow, a bespoke OAuth client) needs a CSRF-safe `state` value it can
 * round-trip through an external IdP and verify on the callback. We mint a
 * short-lived (10-min) HS512 JWT over the SAME symmetric key as session
 * cookies (`auth/sessionSigningKey.ts`) — machine-stable, vault-persisted, no
 * separate rotation.
 *
 * The audience is auto-bound to `plugin:<pluginId>` by the kernel. A token
 * minted for plugin A therefore fails `jwtVerify` in plugin B (audience
 * mismatch) — one compromised plugin cannot forge state for another. The
 * signing key is held by the kernel and never reaches plugin code; plugins
 * only ever see the opaque token string.
 *
 * This is deliberately distinct from `oauth/state.ts`, which carries the fixed
 * broker claim-set (flowId/jobId/providerId/fieldKey) under the shared
 * `plugin-oauth` audience. Here the claims are arbitrary and the audience is
 * per-plugin.
 */

import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS512';
const ISSUER = 'omadia';
const DEFAULT_TTL = '10m';

/** Audience claim for a plugin-flow state token. Kept in one place so signing
 *  and verifying can never drift. */
export function flowAudience(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * Sign arbitrary claims into a flow-state token bound to `pluginId`. Standard
 * claims (`iss`, `aud`, `iat`, `exp`) are set by the kernel; caller-supplied
 * keys colliding with those are ignored (the protected/registered claims win).
 */
export async function signFlowState(
  pluginId: string,
  claims: Record<string, unknown>,
  key: Uint8Array,
  expiresIn: string = DEFAULT_TTL,
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(flowAudience(pluginId))
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Verify a flow-state token. Throws when the signature is invalid, the
 * audience is not `plugin:<pluginId>`, the issuer is wrong, or the TTL has
 * expired. Returns the full decoded payload (custom claims + standard claims).
 */
export async function verifyFlowState(
  pluginId: string,
  token: string,
  key: Uint8Array,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: flowAudience(pluginId),
    algorithms: [ALG],
  });
  return payload as Record<string, unknown>;
}
