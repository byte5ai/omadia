import { createSign } from 'node:crypto';

/**
 * The shared GitHub App JWT minter.
 *
 * A GitHub App authenticates to the API as itself with a short-lived RS256 JWT
 * signed by its private key, then exchanges that for an installation token. Two
 * places mint this JWT: the issue-reporting provider
 * (`plugins/builder/githubAppAuth.ts`) and the dev platform's scoped, revocable
 * job tokens. Rather than duplicate the signing — a security primitive is the
 * last thing to copy-paste — both call this.
 *
 * Lives in `services/` rather than under `devplatform/` where it was first
 * written (epic #470 W2): core's builder imported it from there, which made the
 * dev-platform tree a dependency of core and blocked extracting that tree into
 * its own repository. The primitive itself is generic GitHub App auth and has
 * nothing dev-platform-specific about it.
 * See `specs/470-dev-platform-plugin/core-decoupling-checklist.md`.
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
