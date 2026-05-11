import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  MigrationHookError,
  MigrationTimeoutError,
} from '@omadia/plugin-api';

import { JobScheduler } from '../src/plugins/jobScheduler.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { MigrationRunner } from '../src/plugins/migrationRunner.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { NativeToolRegistry } from '@omadia/orchestrator';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * Tests for MigrationRunner.
 *
 * Each test writes a fake v2 plugin module (plain JS, since the dynamic
 * import treats it as ESM) to a tmp dir and points the runner at it. The
 * manifest is materialised too so the catalog can load it for the timeout
 * override.
 */

const AGENT_ID = 'test.migration.agent';

interface Fixture {
  runner: MigrationRunner;
  vault: InMemorySecretVault;
  catalog: PluginCatalog;
  registry: InMemoryInstalledRegistry;
  tmpRoot: string;
  pluginDir: string;
  manifestDir: string;
}

async function buildFixture(): Promise<Fixture> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'migration-runner-test-'));
  const pluginDir = join(tmpRoot, 'v2-package');
  const distDir = join(pluginDir, 'dist');
  const manifestDir = join(tmpRoot, 'manifests');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });

  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: AGENT_ID,
    installed_version: '1.0.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: { carry: 'over' },
  });
  const serviceRegistry = new ServiceRegistry();
  const catalog = new PluginCatalog({
    manifestDir,
    extraSources: () => [{ packageRoot: pluginDir }],
  });
  await catalog.load();

  const runner = new MigrationRunner({
    vault,
    registry,
    catalog,
    serviceRegistry,
    nativeToolRegistry: new NativeToolRegistry(),
    pluginRouteRegistry: new PluginRouteRegistry(),
    jobScheduler: new JobScheduler({ log: () => {} }),
    log: () => {},
  });
  return { runner, vault, catalog, registry, tmpRoot, pluginDir, manifestDir };
}

function writeManifest(pluginDir: string, timeoutMs?: number): void {
  const base = [
    'schema_version: "1"',
    'identity:',
    `  id: ${AGENT_ID}`,
    '  name: Test Migration Agent',
    '  version: 2.0.0',
    '  kind: agent',
    'lifecycle:',
    '  entry: dist/plugin.js',
  ];
  if (typeof timeoutMs === 'number') {
    base.push('  onMigrate:');
    base.push(`    timeout_ms: ${timeoutMs}`);
  }
  writeFileSync(join(pluginDir, 'manifest.yaml'), base.join('\n') + '\n');
}

function writeModule(pluginDir: string, body: string): void {
  writeFileSync(join(pluginDir, 'dist', 'plugin.js'), body);
}

describe('MigrationRunner', () => {
  let fx: Fixture;

  before(async () => {
    fx = await buildFixture();
  });
  after(() => {
    rmSync(fx.tmpRoot, { recursive: true, force: true });
  });

  async function reloadCatalog(): Promise<void> {
    await fx.catalog.load();
  }

  it('carries previousConfig over 1:1 when module has no onMigrate export', async () => {
    writeManifest(fx.pluginDir);
    writeModule(fx.pluginDir, `export async function activate() { return {}; }\n`);
    await reloadCatalog();
    const entry = fx.catalog.get(AGENT_ID);
    assert.ok(entry, 'catalog entry present');

    const result = await fx.runner.run({
      agentId: AGENT_ID,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      previousConfig: { carry: 'over' },
      stagingPackageRoot: fx.pluginDir,
      entryPath: 'dist/plugin.js',
      catalogEntry: entry,
    });
    assert.deepEqual(result.newConfig, { carry: 'over' });
  });

  it('returns newConfig from a successful onMigrate hook', async () => {
    const sub = join(fx.tmpRoot, 'happy');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub);
    writeModule(
      sub,
      `export async function onMigrate(ctx) {
         return { newConfig: { migrated: true, from: ctx.fromVersion, to: ctx.toVersion } };
       }\n`,
    );
    fx.catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await fx.catalog.load();
    const runner = new MigrationRunner({
      vault: fx.vault,
      registry: fx.registry,
      catalog: fx.catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });
    const entry = fx.catalog.get(AGENT_ID)!;

    const result = await runner.run({
      agentId: AGENT_ID,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      previousConfig: {},
      stagingPackageRoot: sub,
      entryPath: 'dist/plugin.js',
      catalogEntry: entry,
    });
    assert.deepEqual(result.newConfig, {
      migrated: true,
      from: '1.0.0',
      to: '2.0.0',
    });
  });

  it('wraps a sync throw in MigrationHookError', async () => {
    const sub = join(fx.tmpRoot, 'sync-throw');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub);
    writeModule(
      sub,
      `export async function onMigrate() { throw new Error('boom-sync'); }\n`,
    );
    const catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await catalog.load();
    const runner = new MigrationRunner({
      vault: fx.vault,
      registry: fx.registry,
      catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });

    await assert.rejects(
      runner.run({
        agentId: AGENT_ID,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        previousConfig: {},
        stagingPackageRoot: sub,
        entryPath: 'dist/plugin.js',
        catalogEntry: catalog.get(AGENT_ID)!,
      }),
      (err: unknown) => err instanceof MigrationHookError && /boom-sync/.test((err as Error).message),
    );
  });

  it('wraps an async rejection in MigrationHookError', async () => {
    const sub = join(fx.tmpRoot, 'async-throw');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub);
    writeModule(
      sub,
      `export async function onMigrate() {
         await new Promise(r => setTimeout(r, 10));
         throw new Error('boom-async');
       }\n`,
    );
    const catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await catalog.load();
    const runner = new MigrationRunner({
      vault: fx.vault,
      registry: fx.registry,
      catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });

    await assert.rejects(
      runner.run({
        agentId: AGENT_ID,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        previousConfig: {},
        stagingPackageRoot: sub,
        entryPath: 'dist/plugin.js',
        catalogEntry: catalog.get(AGENT_ID)!,
      }),
      (err: unknown) => err instanceof MigrationHookError && /boom-async/.test((err as Error).message),
    );
  });

  it('throws MigrationTimeoutError when the hook blocks past the configured timeout', async () => {
    const sub = join(fx.tmpRoot, 'timeout');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub, 50);
    writeModule(
      sub,
      `export async function onMigrate() {
         await new Promise(() => {}); // never resolves
       }\n`,
    );
    const catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await catalog.load();
    const runner = new MigrationRunner({
      vault: fx.vault,
      registry: fx.registry,
      catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });

    await assert.rejects(
      runner.run({
        agentId: AGENT_ID,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        previousConfig: {},
        stagingPackageRoot: sub,
        entryPath: 'dist/plugin.js',
        catalogEntry: catalog.get(AGENT_ID)!,
      }),
      (err: unknown) => err instanceof MigrationTimeoutError && /50ms/.test((err as Error).message),
    );
  });

  it('rejects a return value that lacks newConfig', async () => {
    const sub = join(fx.tmpRoot, 'bad-return');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub);
    writeModule(
      sub,
      `export async function onMigrate() { return { nope: true }; }\n`,
    );
    const catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await catalog.load();
    const runner = new MigrationRunner({
      vault: fx.vault,
      registry: fx.registry,
      catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });

    await assert.rejects(
      runner.run({
        agentId: AGENT_ID,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        previousConfig: {},
        stagingPackageRoot: sub,
        entryPath: 'dist/plugin.js',
        catalogEntry: catalog.get(AGENT_ID)!,
      }),
      (err: unknown) =>
        err instanceof MigrationHookError &&
        /newConfig/.test((err as Error).message),
    );
  });

  it('allows the hook to write secrets via ctx.secrets.set', async () => {
    const sub = join(fx.tmpRoot, 'secret-write');
    mkdirSync(join(sub, 'dist'), { recursive: true });
    writeManifest(sub);
    writeModule(
      sub,
      `export async function onMigrate(ctx) {
         await ctx.secrets.set('new_token', 'value-v2');
         return { newConfig: {} };
       }\n`,
    );
    const vault = new InMemorySecretVault();
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: AGENT_ID,
      installed_version: '1.0.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
    const catalog = new PluginCatalog({
      manifestDir: fx.manifestDir,
      extraSources: () => [{ packageRoot: sub }],
    });
    await catalog.load();
    const runner = new MigrationRunner({
      vault,
      registry,
      catalog,
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: new NativeToolRegistry(),
      pluginRouteRegistry: new PluginRouteRegistry(),
      jobScheduler: new JobScheduler({ log: () => {} }),
      log: () => {},
    });

    await runner.run({
      agentId: AGENT_ID,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      previousConfig: {},
      stagingPackageRoot: sub,
      entryPath: 'dist/plugin.js',
      catalogEntry: catalog.get(AGENT_ID)!,
    });

    assert.equal(await vault.get(AGENT_ID, 'new_token'), 'value-v2');
  });
});
