/**
 * Platform-owned vault scope for auth artefacts.
 *
 * The colon prefix is deliberate — it puts the scope outside the reserved
 * format for plugin ids (`de.byte5.…`) so an errant install flow can never
 * collide. No plugin catalog entry exists for this id, so no `PluginContext`
 * is ever handed out against it: only middleware auth code touches it.
 *
 * Stored keys:
 *   session_signing_key   — 64 random bytes, base64, used to sign session JWTs
 *   refresh:<email>       — Azure AD refresh_token for the given user
 */
export const CORE_AUTH_AGENT_ID = 'core:auth';

export function refreshTokenKey(email: string): string {
  return `refresh:${email.toLowerCase()}`;
}
