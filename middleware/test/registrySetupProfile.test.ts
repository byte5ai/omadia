// OM-15 (#602) — read-back for the REMOTE path of the store card's
// installation-effort profile. The local catalog path is covered by
// `setupProfileManifest.test.ts`; this proves the branch that actually matters
// for the Google Workspace plugin, which ships via `hub.omadia.ai` and reaches
// the store only through the registry teaser (`manifest_summary.setup_profile`)
// projected by `registryEntryToPlugin`. Assertions read the plugin OUT of the
// real GET /store response, not a projection helper in isolation.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { RegistryClient, type RegistryClientDeps } from '../src/plugins/registryClient.js';
import { createStoreRouter } from '../src/routes/store.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';

const HUB = 'https://hub.test';

function remotePlugin(id: string, setupProfile: unknown): unknown {
  return {
    id,
    name: id,
    kind: 'integration',
    domain: 'productivity.google',
    description: 'Connect Google Workspace.',
    categories: ['productivity'],
    authors: [{ name: 'byte5' }],
    license: 'MIT',
    icon_url: null,
    latest_version: '1.0.0',
    versions: [
      {
        version: '1.0.0',
        compat_core: '>=1.0 <2.0',
        sha256: 'a'.repeat(64),
        size_bytes: 1,
        download_url: `${HUB}/registry/${id}/1.0.0/plugin.zip`,
        published_at: '2026-05-29T11:00:00Z',
        // The hub flattens the manifest's `listing.setup_profile` into the
        // teaser here; store.ts re-validates it through the SAME parser the
        // local catalog uses (parseSetupProfile).
        manifest_summary: { setup_profile: setupProfile },
      },
    ],
  };
}

function indexJson(plugins: unknown[]): string {
  return JSON.stringify({
    schema_version: '1',
    registry: { name: 'omadia-public', url: HUB },
    generated_at: '2026-05-29T12:00:00Z',
    plugins,
  });
}

function mockFetch(body: string): RegistryClientDeps['fetchImpl'] {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    return url === `${HUB}/registry/index.json`
      ? new Response(body)
      : new Response('nf', { status: 404 });
  };
}

const emptyCatalog = {
  list: () => [],
  get: () => undefined,
} as unknown as PluginCatalog;

const fakeRegistry = {
  has: () => false,
  get: () => undefined,
} as unknown as InstalledRegistry;

const FULL_PROFILE = {
  audience: 'it_admin',
  estimated_minutes: 15,
  requirement: {
    en: 'Google Workspace super-admin required',
    de: 'Google-Workspace-Super-Admin erforderlich',
  },
};

describe('store router · remote setup_profile projection (OM-15 #602)', () => {
  let server: Server;
  let base: string;

  before(() => {
    const client = new RegistryClient({
      registries: [{ name: 'omadia-public', url: HUB }],
      log: () => {},
      fetchImpl: mockFetch(
        indexJson([
          remotePlugin('@omadia/google-workspace', FULL_PROFILE),
          // A malformed remote teaser must degrade to "no prerequisites row",
          // never a raw/partial object on the card.
          remotePlugin('@omadia/bad-profile', {
            audience: 'wizard',
            estimated_minutes: 0,
          }),
          // A plugin that declares no profile carries none.
          remotePlugin('@omadia/no-profile', undefined),
        ]),
      ),
    });
    const app = express();
    app.use(
      '/store',
      createStoreRouter({ catalog: emptyCatalog, registry: fakeRegistry, client }),
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a valid remote setup_profile lands on the store plugin verbatim', async () => {
    const body = (await (await fetch(base)).json()) as { items: Plugin[] };
    const gw = body.items.find((p) => p.id === '@omadia/google-workspace');
    assert.ok(gw, 'the remote GW plugin is in the store list');
    assert.deepEqual(gw.setup_profile, FULL_PROFILE);
  });

  it('a malformed remote setup_profile is dropped, not shown raw', async () => {
    const body = (await (await fetch(base)).json()) as { items: Plugin[] };
    const bad = body.items.find((p) => p.id === '@omadia/bad-profile');
    assert.ok(bad, 'the malformed-profile plugin still lists');
    // unknown audience + non-positive minutes → nothing usable → no row
    assert.equal(bad.setup_profile, undefined);
  });

  it('a remote plugin with no profile carries none', async () => {
    const body = (await (await fetch(base)).json()) as { items: Plugin[] };
    const none = body.items.find((p) => p.id === '@omadia/no-profile');
    assert.ok(none, 'the no-profile plugin still lists');
    assert.equal(none.setup_profile, undefined);
  });
});
