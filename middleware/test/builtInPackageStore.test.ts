import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { runLegacyBootstrap } from '../src/plugins/bootstrap.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import type { Config } from '../src/config.js';

function writeManifest(
  packageRoot: string,
  id: string,
  version: string,
  opts: { withSecret?: boolean } = {},
): void {
  mkdirSync(packageRoot, { recursive: true });
  const lines = [
    'schema_version: "1"',
    'identity:',
    `  id: ${id}`,
    `  name: ${id.split('.').pop() ?? id}`,
    `  version: ${version}`,
    '  kind: agent',
    'lifecycle:',
    '  entry: dist/plugin.js',
  ];
  if (opts.withSecret) {
    lines.push('setup:');
    lines.push('  fields:');
    lines.push('    - key: api_token');
    lines.push('      type: secret');
    lines.push('      label: API Token');
  }
  writeFileSync(join(packageRoot, 'manifest.yaml'), lines.join('\n') + '\n');
}

describe('BuiltInPackageStore', () => {
  it('picks up packages with a valid manifest.yaml and skips non-plugin dirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-store-test-'));
    try {
      writeManifest(join(dir, 'agent-alpha'), 'test.agent.alpha', '1.0.0');
      writeManifest(join(dir, 'agent-beta'), 'test.agent.beta', '2.0.0');
      // Package without manifest.yaml — should be skipped (mirrors plugin-api).
      mkdirSync(join(dir, 'shared-types', 'src'), { recursive: true });
      writeFileSync(join(dir, 'shared-types', 'package.json'), '{}');

      const store = new BuiltInPackageStore(dir);
      await store.load();

      const ids = store.list().map((p) => p.id);
      assert.deepEqual(ids, ['test.agent.alpha', 'test.agent.beta']);
      assert.equal(store.get('test.agent.alpha')?.version, '1.0.0');
      assert.ok(store.has('test.agent.beta'));
      assert.ok(!store.has('shared-types'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing packages dir', async () => {
    const store = new BuiltInPackageStore('/nonexistent/path/abc123');
    await store.load();
    assert.equal(store.list().length, 0);
  });
});

describe('runLegacyBootstrap: built-in auto-install', () => {
  it('seeds InstalledRegistry for built-ins without required secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-bootstrap-test-'));
    try {
      writeManifest(join(dir, 'agent-alpha'), 'test.agent.alpha', '1.0.0');
      writeManifest(
        join(dir, 'agent-needs-secret'),
        'test.agent.needs-secret',
        '1.0.0',
        { withSecret: true },
      );

      const store = new BuiltInPackageStore(dir);
      await store.load();
      const catalog = new PluginCatalog({
        manifestDir: '/nonexistent',
        extraSources: () =>
          store.list().map((p) => ({ packageRoot: p.path })),
      });
      await catalog.load();

      const registry = new InMemoryInstalledRegistry();
      const vault = new InMemorySecretVault();

      await runLegacyBootstrap({
        config: {} as Config,
        catalog,
        registry,
        vault,
        builtInStore: store,
        log: () => {},
      });

      // Package without secret → auto-installed active.
      assert.equal(
        registry.get('test.agent.alpha')?.status,
        'active',
        'package without required secret must auto-install',
      );
      // Package with required secret → NOT auto-installed.
      assert.equal(
        registry.get('test.agent.needs-secret'),
        undefined,
        'package with required secret must NOT auto-install',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent across boots when the registry entry persists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-bootstrap-test-'));
    try {
      writeManifest(join(dir, 'agent-alpha'), 'test.agent.alpha', '1.0.0');

      const store = new BuiltInPackageStore(dir);
      await store.load();
      const catalog = new PluginCatalog({
        manifestDir: '/nonexistent',
        extraSources: () =>
          store.list().map((p) => ({ packageRoot: p.path })),
      });
      await catalog.load();

      const registry = new InMemoryInstalledRegistry();
      const vault = new InMemorySecretVault();
      const commonDeps = {
        config: {} as Config,
        catalog,
        registry,
        vault,
        builtInStore: store,
        log: () => {},
      };

      // First boot auto-installs.
      await runLegacyBootstrap(commonDeps);
      const firstInstalledAt =
        registry.get('test.agent.alpha')?.installed_at;
      assert.ok(firstInstalledAt);

      // Circuit-breaker path: status flips to 'errored' after repeated failures.
      // Seeder must not touch an entry that already exists.
      await registry.markActivationFailed('test.agent.alpha', 'mock boom');
      await registry.markActivationFailed('test.agent.alpha', 'mock boom');
      await registry.markActivationFailed('test.agent.alpha', 'mock boom');
      assert.equal(registry.get('test.agent.alpha')?.status, 'errored');

      await runLegacyBootstrap(commonDeps);
      // Still errored; installed_at unchanged (not re-created).
      assert.equal(registry.get('test.agent.alpha')?.status, 'errored');
      assert.equal(
        registry.get('test.agent.alpha')?.installed_at,
        firstInstalledAt,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
