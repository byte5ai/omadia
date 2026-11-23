/**
 * #2088 — an update of an INSTALLED plugin that makes it an archetype plugin,
 * changes what its archetype is allowed, or moves its tables into its own
 * schema is refused until the operator confirms it (rollout defect D32: such
 * updates ran at once, without a word).
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parse as parseYaml } from 'yaml';

import type { Plugin } from '../src/api/admin-v1.js';
import { archetypeUpdateReasons } from '../src/plugins/archetypeUpdateConfirmation.js';
import { ingestFailureStatus } from '../src/plugins/ingestErrorContract.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import type { UploadedPackage, UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';
import { buildZip } from './_helpers/pluginPackageZip.js';

const DESCRIPTOR = { id: 'facilitator', omits: ['memory', 'tool_grant'], adds: ['agent_turn'], requires: ['own_channel_identity'], noun: 'a facilitator' };
const tool = { kind: 'tool', requires: ['graphPool'] } as never;
const archetypeOnPool = { kind: 'archetype', archetype: DESCRIPTOR, requires: ['graphPool@^1'] } as never;
const archetypeOwnDb = { kind: 'archetype', archetype: DESCRIPTOR, requires: [] } as never;

describe('#2088 archetypeUpdateReasons', () => {
  it('spec 2042 §5.10: an update that makes a plugin a system module is confirmed; extension → system-module is not', () => {
    const systemModule = { kind: 'system-module', requires: [] } as never;
    const extension = { kind: 'extension', requires: [] } as never;
    assert.deepEqual(archetypeUpdateReasons(tool, systemModule), ['becomes_system_module']);
    assert.deepEqual(archetypeUpdateReasons({ kind: 'model' } as never, systemModule), ['becomes_system_module']);
    assert.deepEqual(archetypeUpdateReasons(extension, systemModule), []);
    assert.deepEqual(archetypeUpdateReasons(systemModule, systemModule), []);
  });

  it('a plugin that becomes an archetype plugin, with or without its own database', () => {
    assert.deepEqual(archetypeUpdateReasons(tool, archetypeOnPool), ['becomes_archetype']);
    assert.deepEqual(archetypeUpdateReasons(tool, archetypeOwnDb), ['becomes_archetype', 'moves_database']);
  });

  it('an archetype plugin that stops asking for the shared pool moves its tables', () => {
    assert.deepEqual(archetypeUpdateReasons(archetypeOnPool, archetypeOwnDb), ['moves_database']);
    const optional = { kind: 'archetype', archetype: DESCRIPTOR, optional_requires: ['graphPool'] } as never;
    assert.deepEqual(archetypeUpdateReasons(optional, archetypeOwnDb), ['moves_database']);
  });

  it('a change of what the kernel enforces, in any of the lists or the id', () => {
    for (const changed of [
      { ...DESCRIPTOR, omits: ['memory'] },
      { ...DESCRIPTOR, adds: ['agent_turn', 'conversation_messages'] },
      { ...DESCRIPTOR, requires: [] },
      { ...DESCRIPTOR, id: 'moderator' },
    ]) {
      const next = { kind: 'archetype', archetype: changed, requires: [] } as never;
      assert.deepEqual(archetypeUpdateReasons(archetypeOwnDb, next), ['descriptor_changed']);
    }
  });

  it('a plain version bump needs nothing: same lists in another order, other texts', () => {
    const reordered = {
      kind: 'archetype',
      archetype: { ...DESCRIPTOR, omits: ['tool_grant', 'memory'], noun: 'a moderator', roleContract: 'new words', label: 'Moderator' },
      requires: [],
    } as never;
    assert.deepEqual(archetypeUpdateReasons(archetypeOwnDb, reordered), []);
    assert.deepEqual(archetypeUpdateReasons(archetypeOnPool, archetypeOnPool), []);
  });

  it('never asks for an update to something that is not an archetype plugin', () => {
    assert.deepEqual(archetypeUpdateReasons(tool, tool), []);
    assert.deepEqual(archetypeUpdateReasons(archetypeOwnDb, tool), []);
  });
});

describe('#2088 the ingest refuses an unconfirmed archetype update of an installed plugin', () => {
  const ID = '@e2e/arch-own';
  let packagesDir: string;
  let manifest: string;

  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-archetype-update-'));
    manifest = await fs.readFile(new URL('./fixtures/archetype-plugin.manifest.yaml', import.meta.url), 'utf-8');
  });
  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  async function setup(opts: { installedPlugin: Partial<Plugin>; installed: boolean }) {
    const seedDir = path.join(packagesDir, ID, '0.5.1');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, 'manifest.yaml'), manifest.replace('version: "0.5.2"', 'version: "0.5.1"'), 'utf-8');
    const seed: UploadedPackage = {
      id: ID,
      version: '0.5.1',
      path: seedDir,
      uploaded_at: '2026-11-01T00:00:00.000Z',
      uploaded_by: 'seed@example.test',
      sha256: 'a'.repeat(64),
      peers_missing: [],
      zip_bytes: 1,
      extracted_bytes: 1,
      file_count: 1,
    };
    const packages = new Map<string, UploadedPackage>([[ID, seed]]);
    const store = {
      get: (id: string) => packages.get(id),
      has: (id: string) => packages.has(id),
      list: () => [...packages.values()],
      register: (pkg: UploadedPackage) => {
        packages.set(pkg.id, pkg);
        return Promise.resolve();
      },
    } as unknown as UploadedPackageStore;
    const catalog = {
      get: (id: string) => (id === ID ? { plugin: { id: ID, version: '0.5.1', ...opts.installedPlugin } } : undefined),
      load: () => Promise.resolve(),
      list: () => [],
      isBundledId: () => false,
    } as unknown as PluginCatalog;
    const registry = new InMemoryInstalledRegistry();
    if (opts.installed) {
      await registry.register({ id: ID, installed_version: '0.5.1', installed_at: '2026-11-01T00:00:00.000Z', status: 'active', config: {} });
    }
    let activations = 0;
    const service = new PackageUploadService({
      store,
      catalog,
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      registry,
      onPackageReady: () => {
        activations += 1;
        return Promise.resolve();
      },
      log: () => undefined,
    });
    const zip = await buildZip({
      'manifest.yaml': manifest,
      'dist/plugin.mjs': 'export function activate() {}\n',
      'migrations/0001_init.sql': 'CREATE TABLE IF NOT EXISTS plg_e2e_arch_own_things (id int);\n',
    });
    const ingest = (confirmArchetype?: boolean) =>
      service.ingest({
        fileBuffer: zip,
        originalFilename: 'arch-own-0.5.2.zip',
        uploadedBy: 'operator@example.test',
        ...(confirmArchetype ? { confirmArchetype: true } : {}),
      }) as Promise<{ ok: boolean; code?: string; message?: string; details?: Record<string, unknown>; params?: unknown }>;
    return { ingest, packages, activations: () => activations };
  }

  it('refuses with what is being confirmed, leaves the installed version alone, and answers 409', async () => {
    const h = await setup({ installedPlugin: { kind: 'tool', requires: ['graphPool'] } as never, installed: true });
    const refused = await h.ingest();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'package.archetype_confirmation_required');
    assert.deepEqual(refused.details?.['reasons'], ['becomes_archetype', 'moves_database']);
    assert.equal((refused.details?.['archetype'] as { id: string }).id, 'facilitator');
    assert.deepEqual(refused.params, { pluginId: ID, fromVersion: '0.5.1', toVersion: '0.5.2' });
    assert.equal(ingestFailureStatus('package.archetype_confirmation_required'), 409);
    assert.equal(h.packages.get(ID)?.version, '0.5.1');
    assert.equal(h.activations(), 0);
  });

  it('runs once the operator confirmed', async () => {
    const h = await setup({ installedPlugin: { kind: 'tool', requires: ['graphPool'] } as never, installed: true });
    const result = await h.ingest(true);
    assert.equal(result.ok, true, result.message ?? 'no message');
    assert.equal(h.packages.get(ID)?.version, '0.5.2');
    assert.equal(h.activations(), 1);
  });

  it('asks nothing for a plugin that is not installed: the install job confirms that', async () => {
    const h = await setup({ installedPlugin: { kind: 'tool' } as never, installed: false });
    assert.equal((await h.ingest()).ok, true);
  });

  it('asks nothing for a plain version bump of the same archetype plugin', async () => {
    const descriptor = (parseYaml(manifest) as { archetype: { id: string; omits: string[]; adds: string[]; requires: string[] } }).archetype;
    const h = await setup({
      installedPlugin: { kind: 'archetype', archetype: descriptor, requires: [], optional_requires: [] } as never,
      installed: true,
    });
    const result = await h.ingest();
    assert.equal(result.ok, true, result.message ?? 'no message');
    assert.equal(h.activations(), 1);
  });
});
