import crypto from 'node:crypto';

/**
 * #1620 — mint Entra-shaped Teams SSO tokens for tests: a real RS256 JWS over
 * a keypair generated per process, plus the JWKS document that publishes it.
 */

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
export const BOT_APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const TEAMS_WEB_CLIENT = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346';
export const KID = 'test-kid-1';

const signingKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
/** A second keypair, never published — signs forged tokens. */
const forgerKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

export function jwksDocument(kid = KID): { keys: Record<string, unknown>[] } {
  return {
    keys: [{ ...signingKeys.publicKey.export({ format: 'jwk' }), kid, use: 'sig' }],
  };
}

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export interface MintOptions {
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  /** Sign with the unpublished key — a forged signature. */
  readonly forged?: boolean;
}

/** A valid delegated Teams SSO token (v2 shape), overridable claim by claim.
 *  A claim set to `undefined` is removed. */
export function mintTeamsToken(opts: MintOptions = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    aud: BOT_APP_ID,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    azp: TEAMS_WEB_CLIENT,
    scp: 'access_as_user',
    oid: 'user-oid-1',
    preferred_username: 'ada@example.com',
    iat: nowSeconds - 60,
    nbf: nowSeconds - 60,
    exp: nowSeconds + 3600,
    ...opts.claims,
  };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[key];
  }
  const header = { alg: 'RS256', typ: 'JWT', kid: KID, ...opts.header };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const key = opts.forged ? forgerKeys.privateKey : signingKeys.privateKey;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), key)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}
