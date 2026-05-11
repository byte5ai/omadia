import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { AdminAuditLog, type AuditEntry } from '../../src/auth/adminAuditLog.js';
import {
  PlatformSettingsStore,
  SETTING_AUTH_ACTIVE_PROVIDERS,
} from '../../src/auth/platformSettings.js';
import {
  ProviderCatalog,
  ProviderRegistry,
} from '../../src/auth/providerRegistry.js';
import type { AuthProvider } from '../../src/auth/providers/AuthProvider.js';
import { createAdminAuthRouter } from '../../src/routes/adminAuth.js';

/**
 * Provider-toggle integration test. Stubs the platform-settings KV +
 * audit log with in-memory equivalents and drives the router via real
 * Express + fetch. Asserts the D1=C "Hybrid Whitelist+Vault" semantics:
 *   - admin can enable / disable inside the catalog (= env-var whitelist)
 *   - admin cannot enable a provider that's not in the catalog
 *   - admin cannot disable the provider their own session was minted by
 *   - admin cannot disable the last active provider (would lock the door)
 */

const fakeLocal: AuthProvider = {
  id: 'local',
  displayName: 'Email & Password',
  kind: 'password',
  async verify() {
    return { outcome: 'error', code: 'invalid_credentials', message: 'stub' };
  },
};
const fakeEntra: AuthProvider = {
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

class InMemorySettings {
  store = new Map<string, unknown>();
  async get<T>(k: string): Promise<T | null> {
    return (this.store.get(k) as T | undefined) ?? null;
  }
  async set(k: string, v: unknown): Promise<void> {
    this.store.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
}

class InMemoryAuditLog {
  entries: AuditEntry[] = [];
  async record(input: {
    actor: { id?: string; email?: string };
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    this.entries.push({
      id: `audit-${this.entries.length + 1}`,
      actorId: input.actor.id ?? null,
      actorEmail: input.actor.email ?? null,
      action: input.action,
      target: input.target,
      before: input.before ?? null,
      after: input.after ?? null,
      createdAt: new Date(),
    });
  }
}

interface ForgedSession {
  sub: string;
  email: string;
  display_name: string;
  role: 'admin';
  provider: string;
}

describe('/api/v1/admin/auth/providers router', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  let registry: ProviderRegistry;
  let catalog: ProviderCatalog;
  let settings: InMemorySettings;
  let audit: InMemoryAuditLog;
  let session: ForgedSession;

  before(() => {
    catalog = new ProviderCatalog();
    catalog.add(fakeLocal);
    catalog.add(fakeEntra);
    registry = new ProviderRegistry();
    registry.replaceActive([fakeLocal, fakeEntra]);
    settings = new InMemorySettings();
    audit = new InMemoryAuditLog();
    session = {
      sub: 'admin@example.com',
      email: 'admin@example.com',
      display_name: 'Admin',
      role: 'admin',
      // Authenticated via local — disabling 'local' must 409.
      provider: 'local',
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request).session = session;
      next();
    });
    app.use(
      '/api/v1/admin/auth',
      createAdminAuthRouter({
        registry,
        catalog,
        settings: settings as unknown as PlatformSettingsStore,
        audit: audit as unknown as AdminAuditLog,
      }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /providers returns catalog with active flags', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/auth/providers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; configured: boolean; active: boolean }>;
    };
    assert.equal(body.providers.length, 2);
    const ids = body.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ['entra', 'local']);
    assert.equal(body.providers.every((p) => p.configured), true);
    assert.equal(body.providers.every((p) => p.active), true);
  });

  it('POST /providers/entra/disable removes entra + persists + audits', async () => {
    const before = audit.entries.length;
    const res = await fetch(
      `${baseUrl}/api/v1/admin/auth/providers/entra/disable`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    assert.equal(registry.has('entra'), false);
    assert.equal(registry.has('local'), true);
    assert.deepEqual(
      settings.store.get(SETTING_AUTH_ACTIVE_PROVIDERS),
      ['local'],
    );
    assert.equal(audit.entries.length, before + 1);
    assert.equal(audit.entries.at(-1)?.action, 'auth.provider_disable');
  });

  it('POST /providers/entra/enable re-adds entra + persists', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/admin/auth/providers/entra/enable`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    assert.equal(registry.has('entra'), true);
    assert.deepEqual(
      (settings.store.get(SETTING_AUTH_ACTIVE_PROVIDERS) as string[]).sort(),
      ['entra', 'local'],
    );
  });

  it('POST /providers/google/enable refuses with 409 not_in_whitelist', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/admin/auth/providers/google/enable`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'admin_auth.not_in_whitelist');
  });

  it('POST /providers/local/disable refuses with 409 self_lockout (session minted via local)', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/admin/auth/providers/local/disable`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'admin_auth.self_lockout');
  });

  it('POST /providers/last/disable refuses with 409 last_active_provider', async () => {
    // Set up a one-active-provider scenario by switching session away from
    // local + disabling entra first.
    session = { ...session, provider: 'entra' };
    registry.unregister('entra');
    // Now only 'local' is active. The session is on 'entra' (not the
    // active one), so self_lockout doesn't trigger; last_active does.
    const res = await fetch(
      `${baseUrl}/api/v1/admin/auth/providers/local/disable`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'admin_auth.last_active_provider');
  });
});
