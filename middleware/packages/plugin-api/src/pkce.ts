/**
 * RFC 7636 — PKCE helpers, exported as pure SDK functions (spec 004 FR-B4).
 *
 * Lifted from the kernel's `src/plugins/oauth/pkce.ts` so any plugin running
 * its own redirect flow (the GitHub App-Manifest dance, a device flow, a
 * bespoke OAuth client) can mint a verifier/challenge pair without reaching
 * back into the middleware. The kernel re-exports these same functions, so
 * there is a single implementation.
 *
 * Verifier is a high-entropy (32-byte) URL-safe base64 string; challenge is
 * the S256 hash of the verifier in URL-safe base64. Both are fully stateless —
 * the caller stores the verifier and sends the challenge through the IdP
 * round-trip.
 */

import crypto from 'node:crypto';

/** RFC 7636 §4.1 verifier length is 43-128 chars; 32 random bytes ≈ 43
 *  base64url chars, the minimum spec-allowed. 32B already gives 256 bits of
 *  entropy. */
const VERIFIER_BYTES = 32;

/** Base64url encode without padding — what RFC 7636 requires. */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Generate a fresh PKCE code-verifier. The caller MUST store this securely
 *  until the callback redeems the auth-code. */
export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(VERIFIER_BYTES));
}

/** Compute the S256 code-challenge for a verifier. The challenge is the value
 *  that goes into the authorize-URL; the verifier stays on the server. */
export function computeCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}
