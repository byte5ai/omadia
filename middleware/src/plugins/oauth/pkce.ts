/**
 * RFC 7636 — PKCE helpers for the plugin-OAuth flow.
 *
 * Verifier is a high-entropy (32-byte) URL-safe base64 string; challenge is
 * the S256 hash of the verifier in URL-safe base64. Both are fully
 * stateless — the install-route stores the verifier in pendingFlows and
 * sends the challenge through the IdP roundtrip.
 */

import crypto from 'node:crypto';

/** RFC 7636 §4.1 verifier length is 43-128 chars; 32 random bytes ≈ 43
 *  base64url chars which is the minimum spec-allowed. We could go higher
 *  but 32B already gives 256 bits of entropy. */
const VERIFIER_BYTES = 32;

/** Base64url encode without padding — what RFC 7636 requires. */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Generate a fresh PKCE code-verifier. Caller MUST store this securely
 *  (we use the in-memory pendingFlows store) until the callback redeems
 *  the auth-code. */
export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(VERIFIER_BYTES));
}

/** Compute the S256 code-challenge for a verifier. The challenge is the
 *  value that goes into the authorize-URL; the verifier stays on the
 *  server. */
export function computeCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}
