import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import express from 'express';
import { parse as parseYaml } from 'yaml';

import type { Plugin } from '../src/api/admin-v1.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { loadProfile } from '../src/plugins/profileLoader.js';
import { createProfilesRouter } from '../src/routes/profiles.js';

type Partial_Plugin = Pick<
  Plugin,
  'id' | 'provides' | 'requires' | 'depends_on'
> & {
  kind?: Plugin['kind'];
  name?: string;
  install_state?: Plugin['install_state'];
  incompatibility_reasons?: string[];
};

function makeCatalog(plugins: Partial_Plugin[]): PluginCatalog {
  const map = new Map<
    string,
    {
      plugin: Plugin;
      manifest: unknown;
      source_path: string;
      source_kind: 'manifest-v1';
    }
  >();
  for (const p of plugins) {
    map.set(p.id, {
      plugin: {
        id: p.id,
        kind: p.kind ?? 'tool',
        name: p.name ?? p.id,
        version: '0.1.0',
        latest_version: '0.1.0',
        description: '',
        authors: [],
        license: 'proprietary',
        icon_url: null,
        categories: [],
        domain: 'test',
        compat_core: '>=1.0 <2.0',
        signed: false,
        signed_by: null,
        required_secrets: [],
        permissions_summary: {
          memory_reads: [],
          memory_writes: [],
          graph_reads: [],
          graph_writes: [],
          network_outbound: [],
        },
        integrations_summary: [],
        install_state: p.install_state ?? 'available',
        depends_on: p.depends_on,
        jobs: [],
        provides: p.provides,
        requires: p.requires,
        ...(p.incompatibility_reasons
          ? { incompatibility_reasons: p.incompatibility_reasons }
          : {}),
      },
      manifest: {},
      source_path: `<test>/${p.id}.manifest.yaml`,
      source_kind: 'manifest-v1',
    });
  }
  return {
    get: (id: string) => map.get(id),
    list: () => Array.from(map.values()),
  } as unknown as PluginCatalog;
}

function writeProfile(dir: string, id: string, body: string): void {
  writeFileSync(join(dir, `${id}.yaml`), body);
}

describe('/api/v1/profiles router', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  let tmpDir: string;
  let registry: InMemoryInstalledRegistry;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'profiles-router-test-'));

    writeProfile(
      tmpDir,
      'production',
      [
        'schema_version: 1',
        'id: production',
        'name: Production',
        'description: Full stack',
        'plugins:',
        '  - "@omadia/memory"',
        '  - "@omadia/embeddings"',
        '',
      ].join('\n'),
    );
    writeProfile(
      tmpDir,
      'minimal-dev',
      [
        'schema_version: 1',
        'id: minimal-dev',
        'name: Minimal',
        'description: Minimal stack',
        'plugins:',
        '  - "@omadia/memory"',
        '',
      ].join('\n'),
    );
    writeProfile(
      tmpDir,
      'with-config',
      [
        'schema_version: 1',
        'id: with-config',
        'name: With Config',
        'description: Object-form entries',
        'plugins:',
        '  - id: "@omadia/memory"',
        '    config:',
        '      retention_days: 30',
        '',
      ].join('\n'),
    );
    writeProfile(
      tmpDir,
      'unknown-plugin',
      [
        'schema_version: 1',
        'id: unknown-plugin',
        'name: Unknown',
        'description: Plugin not in catalog',
        'plugins:',
        '  - de.byte5.tool.does-not-exist',
        '',
      ].join('\n'),
    );
    writeProfile(
      tmpDir,
      'incompatible',
      [
        'schema_version: 1',
        'id: incompatible',
        'name: Incompatible',
        'description: Plugin marked incompatible',
        'plugins:',
        '  - de.byte5.tool.legacy',
        '',
      ].join('\n'),
    );

    registry = new InMemoryInstalledRegistry();
    const catalog = makeCatalog([
      {
        id: '@omadia/memory',
        provides: [{ name: 'memoryStore', major: 1 }],
        requires: [],
        depends_on: [],
      },
      {
        id: '@omadia/embeddings',
        provides: [{ name: 'embeddingClient', major: 1 }],
        requires: [],
        depends_on: [],
      },
      {
        id: 'de.byte5.tool.legacy',
        provides: [],
        requires: [],
        depends_on: [],
        install_state: 'incompatible',
        incompatibility_reasons: ['compat_core mismatch'],
      },
    ]);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/profiles',
      createProfilesRouter({ catalog, registry, profilesDir: tmpDir }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Reset registry between tests so apply-idempotency tests stay isolated.
    for (const e of registry.list()) {
      await registry.remove(e.id);
    }
  });

  describe('GET /', () => {
    it('lists all 5 profiles in the test fixture dir', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        items: Array<{ id: string; plugin_count: number }>;
        total: number;
      };
      assert.equal(body.total, 5);
      const ids = body.items.map((i) => i.id).sort();
      assert.deepEqual(ids, [
        'incompatible',
        'minimal-dev',
        'production',
        'unknown-plugin',
        'with-config',
      ]);
    });
  });

  describe('GET /:id', () => {
    it('returns profile detail with normalized plugins', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/production`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        id: string;
        plugins: Array<{ id: string; config: Record<string, unknown> }>;
      };
      assert.equal(body.id, 'production');
      assert.equal(body.plugins.length, 2);
      assert.equal(body.plugins[0]?.id, '@omadia/memory');
    });

    it('returns 404 for unknown profile id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/no-such-profile`);
      assert.equal(res.status, 404);
    });

    it('returns 400 for non-kebab-case profile id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/Bad_ID`);
      assert.equal(res.status, 400);
    });
  });

  describe('POST /:id/apply', () => {
    it('installs all plugins on a fresh registry', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/production/apply`,
        { method: 'POST' },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        profile_id: string;
        installed: Array<{ id: string; version: string }>;
        skipped: unknown[];
        errored: unknown[];
      };
      assert.equal(body.profile_id, 'production');
      assert.equal(body.installed.length, 2);
      assert.equal(body.skipped.length, 0);
      assert.equal(body.errored.length, 0);
      assert.ok(registry.has('@omadia/memory'));
      assert.ok(registry.has('@omadia/embeddings'));
    });

    it('is idempotent — second apply skips already-installed plugins', async () => {
      await fetch(`${baseUrl}/api/v1/profiles/production/apply`, {
        method: 'POST',
      });
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/production/apply`,
        { method: 'POST' },
      );
      const body = (await res.json()) as {
        installed: unknown[];
        skipped: Array<{ id: string; reason: string }>;
        errored: unknown[];
      };
      assert.equal(body.installed.length, 0);
      assert.equal(body.skipped.length, 2);
      assert.equal(body.errored.length, 0);
      assert.ok(body.skipped.every((s) => s.reason === 'already_installed'));
    });

    it('errors plugins not in catalog without aborting', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/unknown-plugin/apply`,
        { method: 'POST' },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        installed: unknown[];
        errored: Array<{ id: string; reason: string; message: string }>;
      };
      assert.equal(body.installed.length, 0);
      assert.equal(body.errored.length, 1);
      assert.equal(body.errored[0]?.reason, 'not_in_catalog');
      assert.match(body.errored[0]?.message ?? '', /not in the catalog/);
    });

    it('errors incompatible plugins with the manifest reason', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/incompatible/apply`,
        { method: 'POST' },
      );
      const body = (await res.json()) as {
        errored: Array<{ id: string; reason: string; message: string }>;
      };
      assert.equal(body.errored.length, 1);
      assert.equal(body.errored[0]?.reason, 'incompatible');
      assert.match(body.errored[0]?.message ?? '', /compat_core mismatch/);
    });

    it('preserves object-form initial config in registry entry', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/with-config/apply`,
        { method: 'POST' },
      );
      assert.equal(res.status, 200);
      const entry = registry.get('@omadia/memory');
      assert.equal(entry?.config['retention_days'], 30);
    });

    it('returns 404 for apply on unknown profile', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/profiles/no-such-profile/apply`,
        { method: 'POST' },
      );
      assert.equal(res.status, 404);
    });

    it('returns 400 for apply with non-kebab-case profile id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/Bad_ID/apply`, {
        method: 'POST',
      });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /export', () => {
    it('returns valid YAML with empty plugins on a fresh registry', async () => {
      const res = await fetch(`${baseUrl}/api/v1/profiles/export`);
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get('content-type') ?? '',
        /yaml/i,
      );
      const yaml = await res.text();
      const parsed = parseYaml(yaml) as {
        schema_version: number;
        id: string;
        plugins: unknown[];
      };
      assert.equal(parsed.schema_version, 1);
      assert.equal(parsed.id, 'exported');
      assert.equal(parsed.plugins.length, 0);
    });

    it('emits string-form for empty config and object-form for non-empty config', async () => {
      await registry.register({
        id: '@omadia/memory',
        installed_version: '0.1.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });
      await registry.register({
        id: '@omadia/embeddings',
        installed_version: '0.1.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: { ollama_base_url: 'http://localhost:11434' },
      });

      const res = await fetch(`${baseUrl}/api/v1/profiles/export`);
      const parsed = parseYaml(await res.text()) as {
        plugins: Array<string | { id: string; config: Record<string, unknown> }>;
      };
      assert.equal(parsed.plugins.length, 2);
      // registry.list() sorts by id: 'embeddings' < 'memory' alphabetically.
      // embeddings has non-empty config → object-form; memory has empty config → string-form.
      assert.deepEqual(parsed.plugins[0], {
        id: '@omadia/embeddings',
        config: { ollama_base_url: 'http://localhost:11434' },
      });
      assert.equal(parsed.plugins[1], '@omadia/memory');
    });

    it('round-trip: apply → export → write → loadProfile → apply on second registry yields identical set', async () => {
      // Step 1: apply production on the live registry (via HTTP)
      await fetch(`${baseUrl}/api/v1/profiles/production/apply`, {
        method: 'POST',
      });
      // Mutate one entry's config so we exercise the object-form path.
      await registry.register({
        id: '@omadia/embeddings',
        installed_version: '0.1.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: { ollama_base_url: 'http://round-trip:11434' },
      });

      // Step 2: GET /export
      const exportRes = await fetch(`${baseUrl}/api/v1/profiles/export`);
      assert.equal(exportRes.status, 200);
      const yaml = await exportRes.text();

      // Step 3: write to a tmp dir as exported.yaml
      const roundTripDir = mkdtempSync(
        join(tmpdir(), 'profiles-round-trip-'),
      );
      try {
        const roundTripFile = join(roundTripDir, 'exported.yaml');
        writeFileSync(roundTripFile, yaml);

        // Step 4: load via loadProfile (this exercises the schema validator)
        const loaded = await loadProfile(roundTripFile);
        assert.equal(loaded.id, 'exported');
        assert.equal(loaded.plugins.length, 2);

        // Step 5: apply on a fresh second registry (using a router pointed
        // at the round-trip dir + a second registry).
        const secondRegistry = new InMemoryInstalledRegistry();
        const secondCatalog = makeCatalog([
          {
            id: '@omadia/memory',
            provides: [{ name: 'memoryStore', major: 1 }],
            requires: [],
            depends_on: [],
          },
          {
            id: '@omadia/embeddings',
            provides: [{ name: 'embeddingClient', major: 1 }],
            requires: [],
            depends_on: [],
          },
        ]);
        const secondApp = express();
        secondApp.use(
          '/api/v1/profiles',
          createProfilesRouter({
            catalog: secondCatalog,
            registry: secondRegistry,
            profilesDir: roundTripDir,
          }),
        );
        const secondServer = secondApp.listen(0);
        try {
          const secondAddr = secondServer.address() as AddressInfo;
          const secondBase = `http://127.0.0.1:${String(secondAddr.port)}`;
          const applyRes = await fetch(
            `${secondBase}/api/v1/profiles/exported/apply`,
            { method: 'POST' },
          );
          assert.equal(applyRes.status, 200);
          const outcome = (await applyRes.json()) as {
            installed: Array<{ id: string }>;
          };
          assert.equal(outcome.installed.length, 2);

          // Step 6: assert configs survived round-trip
          const sourceIds = new Set(registry.list().map((e) => e.id));
          const dstIds = new Set(secondRegistry.list().map((e) => e.id));
          assert.deepEqual([...sourceIds].sort(), [...dstIds].sort());
          const dstEmbeddings = secondRegistry.get(
            '@omadia/embeddings',
          );
          assert.equal(
            dstEmbeddings?.config['ollama_base_url'],
            'http://round-trip:11434',
          );
        } finally {
          await new Promise<void>((resolve) =>
            secondServer.close(() => resolve()),
          );
        }
      } finally {
        rmSync(roundTripDir, { recursive: true, force: true });
      }
    });

    it('exported YAML re-validates against profileLoader (id format, schema_version, kebab-case)', async () => {
      await registry.register({
        id: '@omadia/memory',
        installed_version: '0.1.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });
      const res = await fetch(`${baseUrl}/api/v1/profiles/export`);
      const yaml = await res.text();
      const dir = mkdtempSync(join(tmpdir(), 'export-validate-'));
      try {
        const file = join(dir, 'exported.yaml');
        writeFileSync(file, yaml);
        const profile = await loadProfile(file);
        assert.equal(profile.schema_version, 1);
        assert.equal(profile.id, 'exported');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
