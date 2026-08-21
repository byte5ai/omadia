import { createSign } from 'node:crypto';

/**
 * The shared GitHub App JWT minter.
 *
 * A GitHub App authenticates to the API as itself with a short-lived RS256 JWT
 * signed by its private key, then exchanges that for an installation token.
 * Callers mint it from more than one place — the issue-reporting
 * provider (`plugins/builder/githubAppAuth.ts`), and the dev platform plugin's
 * scoped, revocable job tokens. Rather than duplicate the signing — a security
 * primitive is the last thing to copy-paste — all of them call this.
 *
 * Lives in `services/` rather than inside the subsystem where it was first
 * written (epic #470 W2): core's builder imported it from there, which made a
 * to-be-extracted subtree a dependency of core and blocked extracting it into
 * its own repository. The primitive itself is generic GitHub App auth, so it
 * belongs to core and STAYS here — moving it into the plugin repository would
 * recreate the same leak in the opposite direction, across a repo boundary.
 * See the epic #470 spec set under `specs/`.
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
