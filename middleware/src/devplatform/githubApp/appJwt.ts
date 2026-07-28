import { createSign } from 'node:crypto';

/**
 * Epic #470 W2 — the shared GitHub App JWT minter.
 *
 * A GitHub App authenticates to the API as itself with a short-lived RS256 JWT
 * signed by its private key, then exchanges that for an installation token. Two
 * places mint this JWT: the existing issue-reporting provider
 * (`builder/githubAppAuth.ts`) and W2's scoped, revocable job tokens. Rather than
 * duplicate the signing — a security primitive is the last thing to copy-paste —
 * both call this.
 */

/** GitHub rejects a JWT whose lifetime exceeds 10 minutes; 9 leaves headroom. */
const JWT_TTL_SECONDS = 9 * 60;
/** Backdate to tolerate minor clock skew against GitHub. */
const CLOCK_SKEW_SECONDS = 30;

export function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Mint an App JWT. `now` is injectable so tests get deterministic `iat`/`exp`.
 *
 * @param appId GitHub's numeric App id (as text — it is `iss`).
 * @param privateKey the App's PEM private key.
 * @param now epoch ms; defaults to the wall clock.
 */
export function mintAppJwt(appId: string, privateKey: string, now: () => number = Date.now): string {
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: issuedAt - CLOCK_SKEW_SECONDS,
    exp: issuedAt + JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}
