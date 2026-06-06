import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import {
  GitHubAppTokenProvider,
  type AppAuthFetch,
} from '../../src/plugins/builder/githubAppAuth.js';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('GitHubAppTokenProvider', () => {
  const config = {
    appId: '123456',
    privateKey: PRIVATE_KEY,
    installationId: '987',
  };

  before(() => {
    assert.ok(PUBLIC_KEY.includes('BEGIN PUBLIC KEY'));
  });

  it('mints a valid RS256 JWT and exchanges it for an installation token', async () => {
    let capturedAuth = '';
    let capturedUrl = '';
    const fetch: AppAuthFetch = (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers['Authorization'] ?? '';
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            token: 'ghs_installationtoken',
            expires_at: new Date(1_000_000 + 60 * 60 * 1000).toISOString(),
          }),
      });
    };
    const provider = new GitHubAppTokenProvider({
      config,
      fetch,
      now: () => 1_000_000,
    });

    const token = await provider.getToken();
    assert.equal(token, 'ghs_installationtoken');
    assert.match(capturedUrl, /\/app\/installations\/987\/access_tokens$/);

    // The Authorization header carries a JWT signed by the App key.
    const jwt = capturedAuth.replace(/^Bearer /, '');
    const [header, payload, signature] = jwt.split('.');
    assert.deepEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });
    const claims = decodeSegment(payload);
    assert.equal(claims['iss'], '123456');
    // exp must be within GitHub's 10-minute ceiling of iat.
    assert.ok((claims['exp'] as number) - (claims['iat'] as number) <= 600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    assert.ok(
      verifier.verify(PUBLIC_KEY, Buffer.from(signature, 'base64url')),
      'JWT signature must verify against the App public key',
    );
  });

  it('caches the token and does not re-mint until near expiry', async () => {
    let calls = 0;
    let clock = 2_000_000;
    const fetch: AppAuthFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            token: `tok-${String(calls)}`,
            expires_at: new Date(clock + 60 * 60 * 1000).toISOString(),
          }),
      });
    };
    const provider = new GitHubAppTokenProvider({ config, fetch, now: () => clock });

    const first = await provider.getToken();
    const second = await provider.getToken();
    assert.equal(first, 'tok-1');
    assert.equal(second, 'tok-1');
    assert.equal(calls, 1, 'second call must hit the cache');

    // Advance past expiry − skew (1h − 5min) → forces a refresh.
    clock += 56 * 60 * 1000;
    const third = await provider.getToken();
    assert.equal(third, 'tok-2');
    assert.equal(calls, 2);
  });

  it('throws without leaking the response body on a failed exchange', async () => {
    const fetch: AppAuthFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'A JWT could not be decoded' }),
      });
    const provider = new GitHubAppTokenProvider({ config, fetch, now: () => 3_000_000 });
    await assert.rejects(provider.getToken(), (err: Error) => {
      assert.match(err.message, /status 401/);
      assert.doesNotMatch(err.message, /could not be decoded/);
      return true;
    });
  });
});
