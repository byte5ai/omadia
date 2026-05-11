import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ProviderCatalog,
  ProviderRegistry,
  parseAuthProvidersEnv,
  resolveActiveProviderIds,
} from '../../src/auth/providerRegistry.js';
import type { AuthProvider } from '../../src/auth/providers/AuthProvider.js';

const fakePassword: AuthProvider = {
  id: 'local',
  displayName: 'Email & Password',
  kind: 'password',
  async verify() {
    return { outcome: 'error', code: 'invalid_credentials', message: 'stub' };
  },
};

const fakeOidc: AuthProvider = {
  id: 'entra',
  displayName: 'Microsoft / Entra ID',
  kind: 'oidc',
  async beginLogin() {
    return { redirectUrl: 'https://example.com', pendingState: '{}' };
  },
  async handleCallback() {
    return { outcome: 'error', code: 'callback_invalid', message: 'stub' };
  },
};

describe('parseAuthProvidersEnv', () => {
  it('defaults to ["local"] when env is unset', () => {
    assert.deepEqual(parseAuthProvidersEnv(undefined), ['local']);
    assert.deepEqual(parseAuthProvidersEnv(''), ['local']);
    assert.deepEqual(parseAuthProvidersEnv('   '), ['local']);
  });

  it('lowercases + dedupes + trims', () => {
    assert.deepEqual(
      parseAuthProvidersEnv('  Local , ENTRA, local '),
      ['local', 'entra'],
    );
  });

  it('splits on commas', () => {
    assert.deepEqual(parseAuthProvidersEnv('local,entra'), ['local', 'entra']);
  });
});

describe('ProviderRegistry', () => {
  it('registers + retrieves providers', () => {
    const r = new ProviderRegistry();
    r.register(fakePassword);
    r.register(fakeOidc);
    assert.equal(r.size(), 2);
    assert.equal(r.get('local')?.id, 'local');
    assert.equal(r.get('entra')?.kind, 'oidc');
    assert.equal(r.get('does-not-exist'), undefined);
  });

  it('rejects duplicate registrations', () => {
    const r = new ProviderRegistry();
    r.register(fakePassword);
    assert.throws(() => r.register(fakePassword), /collision/);
  });

  it('exposes summaries in registration order', () => {
    const r = new ProviderRegistry();
    r.register(fakePassword);
    r.register(fakeOidc);
    assert.deepEqual(r.summaries(), [
      { id: 'local', displayName: 'Email & Password', kind: 'password' },
      { id: 'entra', displayName: 'Microsoft / Entra ID', kind: 'oidc' },
    ]);
  });

  it('unregister removes the provider + reports prior presence', () => {
    const r = new ProviderRegistry();
    r.register(fakePassword);
    assert.equal(r.unregister('local'), true);
    assert.equal(r.size(), 0);
    assert.equal(r.unregister('local'), false);
  });

  it('replaceActive swaps the entire active set', () => {
    const r = new ProviderRegistry();
    r.register(fakePassword);
    r.replaceActive([fakeOidc]);
    assert.equal(r.size(), 1);
    assert.equal(r.get('entra')?.id, 'entra');
    assert.equal(r.has('local'), false);
  });
});

describe('ProviderCatalog', () => {
  it('holds the whitelisted superset; ids() reflects insertion order', () => {
    const c = new ProviderCatalog();
    c.add(fakePassword);
    c.add(fakeOidc);
    assert.deepEqual(c.ids(), ['local', 'entra']);
    assert.equal(c.size(), 2);
    assert.equal(c.has('local'), true);
    assert.equal(c.has('google'), false);
  });

  it('rejects duplicate adds', () => {
    const c = new ProviderCatalog();
    c.add(fakePassword);
    assert.throws(() => c.add(fakePassword), /collision/);
  });
});

describe('resolveActiveProviderIds', () => {
  function catalog(): ProviderCatalog {
    const c = new ProviderCatalog();
    c.add(fakePassword);
    c.add(fakeOidc);
    return c;
  }

  it('falls back to "all whitelisted" when stored is null/empty', () => {
    assert.deepEqual(resolveActiveProviderIds(catalog(), null), ['local', 'entra']);
    assert.deepEqual(resolveActiveProviderIds(catalog(), undefined), ['local', 'entra']);
    assert.deepEqual(resolveActiveProviderIds(catalog(), []), ['local', 'entra']);
  });

  it('returns the stored subset when whitelisted', () => {
    assert.deepEqual(resolveActiveProviderIds(catalog(), ['local']), ['local']);
    assert.deepEqual(resolveActiveProviderIds(catalog(), ['entra']), ['entra']);
  });

  it('drops stored ids that are no longer in the whitelist', () => {
    assert.deepEqual(
      resolveActiveProviderIds(catalog(), ['local', 'google']),
      ['local'],
    );
  });
});
