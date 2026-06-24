import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GitHubDeviceFlowProvider,
  createGitHubDeviceProvider,
} from '../../src/issues/githubOAuthProvider.js';

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

function providerWith(
  handler: (url: string) => unknown,
): GitHubDeviceFlowProvider {
  const fetchImpl = ((url: string) =>
    Promise.resolve(response(200, handler(url)))) as unknown as typeof fetch;
  return new GitHubDeviceFlowProvider('cid', fetchImpl);
}

describe('GitHubDeviceFlowProvider', () => {
  it('requests a device code', async () => {
    let capturedUrl = '';
    const provider = new GitHubDeviceFlowProvider(
      'cid',
      ((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          response(200, {
            device_code: 'devc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
        );
      }) as unknown as typeof fetch,
    );
    const dc = await provider.requestDeviceCode(['public_repo']);
    assert.equal(capturedUrl, 'https://github.com/login/device/code');
    assert.equal(dc.deviceCode, 'devc');
    assert.equal(dc.userCode, 'ABCD-1234');
    assert.equal(dc.interval, 5);
  });

  it('returns authorized with a token', async () => {
    const provider = providerWith(() => ({
      access_token: 'gho_x',
      scope: 'public_repo',
      token_type: 'bearer',
    }));
    const r = await provider.pollAccessToken('devc');
    assert.equal(r.status, 'authorized');
    if (r.status === 'authorized') {
      assert.equal(r.accessToken, 'gho_x');
      assert.equal(r.scope, 'public_repo');
    }
  });

  it('maps authorization_pending to pending', async () => {
    const provider = providerWith(() => ({ error: 'authorization_pending' }));
    assert.equal((await provider.pollAccessToken('d')).status, 'pending');
  });

  it('maps slow_down with the new interval', async () => {
    const provider = providerWith(() => ({ error: 'slow_down', interval: 10 }));
    const r = await provider.pollAccessToken('d');
    assert.equal(r.status, 'slow_down');
    if (r.status === 'slow_down') assert.equal(r.interval, 10);
  });

  it('maps expired_token and access_denied', async () => {
    assert.equal(
      (await providerWith(() => ({ error: 'expired_token' })).pollAccessToken('d')).status,
      'expired',
    );
    assert.equal(
      (await providerWith(() => ({ error: 'access_denied' })).pollAccessToken('d')).status,
      'denied',
    );
  });

  it('resolves the authenticated user login', async () => {
    const provider = providerWith(() => ({ login: 'octocat' }));
    assert.equal(await provider.fetchUserLogin('tok'), 'octocat');
  });

  it('factory returns null only for a REPLACE_ placeholder client id', () => {
    // A REPLACE_ placeholder (no real app registered yet) -> unconfigured.
    assert.equal(createGitHubDeviceProvider('REPLACE_WITH_SOMETHING'), null);
    // A real client id (incl. the baked default via undefined) -> provider.
    assert.notEqual(createGitHubDeviceProvider(undefined), null);
    assert.notEqual(createGitHubDeviceProvider('Ov23liRealClientId'), null);
  });
});
