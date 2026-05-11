import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OAuthProviderRegistry } from '../../src/plugins/oauth/providerRegistry.js';
import type { PluginOAuthProvider } from '../../src/plugins/oauth/types.js';

function fakeProvider(id: string): PluginOAuthProvider {
  return {
    id,
    displayName: `Fake ${id}`,
    buildAuthorizeUrl: () => `https://fake.example/${id}`,
    exchangeCode: async () => {
      throw new Error('not used in registry tests');
    },
    refreshAccessToken: async () => {
      throw new Error('not used in registry tests');
    },
  };
}

test('register + has + list', () => {
  const reg = new OAuthProviderRegistry();
  reg.register('microsoft365', () => fakeProvider('microsoft365'));
  assert.ok(reg.has('microsoft365'));
  assert.deepEqual(reg.list(), ['microsoft365']);
});

test('list returns sorted ids', () => {
  const reg = new OAuthProviderRegistry();
  reg.register('zeta', () => fakeProvider('zeta'));
  reg.register('alpha', () => fakeProvider('alpha'));
  reg.register('mu', () => fakeProvider('mu'));
  assert.deepEqual(reg.list(), ['alpha', 'mu', 'zeta']);
});

test('register throws on id collision', () => {
  const reg = new OAuthProviderRegistry();
  reg.register('microsoft365', () => fakeProvider('microsoft365'));
  assert.throws(
    () => reg.register('microsoft365', () => fakeProvider('microsoft365')),
    /id collision/,
  );
});

test('instantiate calls the registered factory with the supplied config', () => {
  const reg = new OAuthProviderRegistry();
  const seen: unknown[] = [];
  reg.register('ms', (cfg) => {
    seen.push(cfg);
    return fakeProvider('ms');
  });
  const cfg = { tenantId: 't', clientId: 'c', clientSecret: 's' };
  const provider = reg.instantiate('ms', cfg);
  assert.equal(provider.id, 'ms');
  assert.deepEqual(seen, [cfg]);
});

test('instantiate throws for unknown providers', () => {
  const reg = new OAuthProviderRegistry();
  assert.throws(() => reg.instantiate('nope', {}), /not registered/);
});

test('has returns false for unregistered ids', () => {
  const reg = new OAuthProviderRegistry();
  assert.equal(reg.has('nope'), false);
});
