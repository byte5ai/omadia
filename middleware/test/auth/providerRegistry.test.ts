import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ProviderCatalog,
  ProviderRegistry,
  parseAuthProvidersEnv,
  resolveActiveProviderIds,
  shouldWarnEmptyAdminAllowlist,
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

/**
 * OM-92 — the empty-allowlist boot warning fired on every desktop start, where
 * only the local password provider is active and `ADMIN_ALLOWED_EMAILS` is
 * meaningless. It claimed "every sign-in will 403" two log lines above a
 * healthy `1 active: local` registry, which a beta tester read as a broken
 * install. The warning now follows the only provider that reads the list.
 */
describe('shouldWarnEmptyAdminAllowlist', () => {
  const entraConfigured = {
    authProviders: 'local,entra',
    hasMicrosoftCredentials: true,
  } as const;

  it('warns when entra is requested, configured and the allowlist is empty', () => {
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        ...entraConfigured,
        whitelistIsEmpty: true,
      }),
      true,
    );
  });

  it('stays silent on a local-password-only install (the desktop default)', () => {
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        authProviders: 'local',
        hasMicrosoftCredentials: false,
        whitelistIsEmpty: true,
      }),
      false,
    );
  });

  it('stays silent when entra is requested but its secrets are missing', () => {
    // The registry logs its own "skipping entra registration" line for this
    // case, naming the actual blocker. A second warning about a *different*
    // secret only sends the operator after the wrong one.
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        authProviders: 'local,entra',
        hasMicrosoftCredentials: false,
        whitelistIsEmpty: true,
      }),
      false,
    );
  });

  it('stays silent when entra is configured but not requested', () => {
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        authProviders: 'local',
        hasMicrosoftCredentials: true,
        whitelistIsEmpty: true,
      }),
      false,
    );
  });

  it('never warns once the allowlist has entries', () => {
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        ...entraConfigured,
        whitelistIsEmpty: false,
      }),
      false,
    );
  });

  it('treats an unset AUTH_PROVIDERS as local-only, so it stays silent', () => {
    // `parseAuthProvidersEnv(undefined)` is `['local']` — the OSS-Demo default.
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        authProviders: undefined,
        hasMicrosoftCredentials: true,
        whitelistIsEmpty: true,
      }),
      false,
    );
  });

  it('tolerates whitespace and casing in AUTH_PROVIDERS', () => {
    assert.equal(
      shouldWarnEmptyAdminAllowlist({
        authProviders: ' LOCAL , Entra ',
        hasMicrosoftCredentials: true,
        whitelistIsEmpty: true,
      }),
      true,
    );
  });
});
