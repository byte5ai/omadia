import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TemplateManifest } from '@omadia/conductor-core';

import type { Plugin } from '../src/api/admin-v1.js';
import { InstallService } from '../src/plugins/installService.js';
import type { InstalledAgent, InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { extractTemplateDeclarations } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { loadPluginTemplates, registerInstalledPluginTemplates } from '../src/plugins/pluginTemplates.js';
import type { PluginTemplateRegistrar } from '../src/plugins/pluginTemplates.js';
import type { SecretVault } from '../src/secrets/vault.js';

// Plugin-borne workflow templates (#478 B3) — the designed trust boundary:
// data-only manifests declared under `permissions.templates`, gated at install
// time by the STRICT distributed-manifest validation (path confinement after
// symlink unwrapping, `plugin:<id>:` namespacing, checkTemplateManifest strict
// mode, cron syntax). Any failure refuses the install; nothing is executed.

const PLUGIN_ID = 'acme-flows';

/** Strict-mode-clean manifest: EVERY ref field is a declared slot (an
 *  undeclared concrete ref is exactly what the gate must reject). */
function strictManifest(id = `plugin:${PLUGIN_ID}:approval`): TemplateManifest {
  return {
    id,
    name: 'Plugin approval',
    description: 'Approval flow shipped by a plugin package.',
    useCase: 'approval',
    defaultSlug: 'plugin-approval',
    graph: {
      entryStepId: 'work',
      steps: [
        { id: 'work', kind: 'agent', agentId: 'slot:agent:worker', prompt: 'Do the work.' },
        {
          id: 'approve',
          kind: 'human',
          human: { principal: { kind: 'role', ref: 'slot:role:approver' }, channel: 'slot:channel:main', message: 'Approve?' },
        },
      ],
      transitions: [{ id: 't1', source: 'work', target: 'approve' }],
      triggers: [{ id: 'cr', kind: 'cron', cron: '0 9 * * *' }],
    },
    slots: {
      agents: [{ key: 'worker', label: 'Worker agent' }],
      roles: [{ key: 'approver', label: 'Approver role' }],
      channels: [{ key: 'main', label: 'Approval channel' }],
    },
  };
}

const tmpRoots: string[] = [];
after(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
});

/** Temp plugin package: `files` maps package-relative paths to file contents. */
async function makePackage(files: Record<string, string>): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'plugin-tpl-'));
  tmpRoots.push(parent);
  const root = path.join(parent, 'pkg');
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

describe('extractTemplateDeclarations', () => {
  it('returns the declared paths; absent block means none', () => {
    assert.deepEqual(extractTemplateDeclarations({ permissions: { templates: ['templates/a.json'] } }), {
      paths: ['templates/a.json'],
      errors: [],
    });
    assert.deepEqual(extractTemplateDeclarations({ permissions: {} }), { paths: [], errors: [] });
    assert.deepEqual(extractTemplateDeclarations(undefined), { paths: [], errors: [] });
  });

  it('fails loud on malformed declarations instead of silently dropping them (security gate)', () => {
    const nonArray = extractTemplateDeclarations({ permissions: { templates: 'templates/a.json' } });
    assert.deepEqual(nonArray.paths, []);
    assert.equal(nonArray.errors.length, 1);

    const mixed = extractTemplateDeclarations({ permissions: { templates: ['templates/a.json', 42, ''] } });
    assert.deepEqual(mixed.paths, ['templates/a.json']);
    assert.equal(mixed.errors.length, 2);
  });
});

describe('loadPluginTemplates — the strict install gate', () => {
  it('accepts a fully-slotted manifest with a valid cron trigger', async () => {
    const root = await makePackage({ 'templates/approval.json': JSON.stringify(strictManifest()) });
    const result = await loadPluginTemplates(PLUGIN_ID, root, ['templates/approval.json']);
    assert.deepEqual(result.errors, []);
    assert.equal(result.manifests.length, 1);
    assert.equal(result.manifests[0]!.id, `plugin:${PLUGIN_ID}:approval`);
  });

  it('rejects an undeclared concrete ref (template_concrete_ref_in_strict_mode)', async () => {
    const manifest = strictManifest();
    manifest.graph.steps[0]!.agentId = 'install-local-agent'; // concrete ref, not a slot
    const root = await makePackage({ 'templates/bad.json': JSON.stringify(manifest) });
    const result = await loadPluginTemplates(PLUGIN_ID, root, ['templates/bad.json']);
    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes('template_concrete_ref_in_strict_mode'), result.errors[0]);
    // the now-unused declared slot is flagged too (bidirectional coverage)
    assert.ok(result.errors[0]!.includes('template_unused_slot'), result.errors[0]);
  });

  it("rejects ids that are not namespaced 'plugin:<pluginId>:<name>' (no shadowing of bundled/user ids)", async () => {
    const root = await makePackage({
      'a.json': JSON.stringify(strictManifest('expense-approval')),
      'b.json': JSON.stringify(strictManifest('plugin:other-plugin:approval')),
      'c.json': JSON.stringify(strictManifest(`plugin:${PLUGIN_ID}:`)),
    });
    const result = await loadPluginTemplates(PLUGIN_ID, root, ['a.json', 'b.json', 'c.json']);
    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 3);
    for (const e of result.errors) assert.ok(e.includes(`plugin:${PLUGIN_ID}:`), e);
  });

  it('rejects paths escaping the package root — plain traversal AND symlink escape', async () => {
    const root = await makePackage({ 'templates/ok.json': JSON.stringify(strictManifest()) });
    // ../outside.json lives NEXT TO the package root, inside the tmp parent.
    await writeFile(path.join(root, '..', 'outside.json'), JSON.stringify(strictManifest()), 'utf8');
    const traversal = await loadPluginTemplates(PLUGIN_ID, root, ['../outside.json']);
    assert.equal(traversal.manifests.length, 0);
    assert.ok(traversal.errors[0]!.includes('outside the package root'), traversal.errors[0]);

    // A confined-LOOKING declared path whose file is a symlink pointing outside.
    await symlink(path.join(root, '..', 'outside.json'), path.join(root, 'templates', 'sneaky.json'));
    const sneaky = await loadPluginTemplates(PLUGIN_ID, root, ['templates/sneaky.json']);
    assert.equal(sneaky.manifests.length, 0);
    assert.ok(sneaky.errors[0]!.includes('outside the package root'), sneaky.errors[0]);
  });

  it('rejects non-.json declarations, unreadable files, invalid JSON, and duplicate ids', async () => {
    const root = await makePackage({
      'templates/ok.json': JSON.stringify(strictManifest()),
      'templates/dupe.json': JSON.stringify(strictManifest()),
      'templates/broken.json': '{ not json',
      'templates/code.js': 'module.exports = 1;',
    });
    const result = await loadPluginTemplates(PLUGIN_ID, root, [
      'templates/ok.json',
      'templates/dupe.json',
      'templates/broken.json',
      'templates/code.js',
      'templates/missing.json',
    ]);
    assert.equal(result.manifests.length, 1); // only ok.json survives
    assert.equal(result.errors.length, 4);
    assert.ok(result.errors.some((e) => e.includes('duplicate template id')), JSON.stringify(result.errors));
    assert.ok(result.errors.some((e) => e.includes('invalid JSON')), JSON.stringify(result.errors));
    assert.ok(result.errors.some((e) => e.includes('only .json')), JSON.stringify(result.errors));
    assert.ok(result.errors.some((e) => e.includes('unreadable')), JSON.stringify(result.errors));
  });

  it('rejects invalid cron trigger values (isValidCron gate)', async () => {
    const manifest = strictManifest();
    manifest.graph.triggers = [{ id: 'cr', kind: 'cron', cron: '99 9 * * *' }];
    const root = await makePackage({ 'templates/cron.json': JSON.stringify(manifest) });
    const result = await loadPluginTemplates(PLUGIN_ID, root, ['templates/cron.json']);
    assert.equal(result.manifests.length, 0);
    assert.ok(result.errors[0]!.includes('invalid cron expression'), result.errors[0]);
  });
});

// ---------------------------------------------------------------------------
// InstallService integration — install-time gate + register/unregister seam
// ---------------------------------------------------------------------------

function makePlugin(id: string): Plugin {
  return {
    id,
    kind: 'tool',
    name: id,
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
    setup_fields: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
  };
}

function makeCatalog(id: string, packageRoot: string, templates: string[]): PluginCatalog {
  const entry = {
    plugin: makePlugin(id),
    manifest: { permissions: { templates } },
    source_path: path.join(packageRoot, 'manifest.yaml'),
    source_kind: 'manifest-v1' as const,
  };
  return {
    get: (pid: string) => (pid === id ? entry : undefined),
    list: () => [entry],
  } as unknown as PluginCatalog;
}

function makeRegistry(): InstalledRegistry {
  const map = new Map<string, InstalledAgent>();
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    register: async (entry) => {
      map.set(entry.id, entry);
    },
    remove: async (id) => {
      map.delete(id);
    },
    markActivationFailed: async () => undefined,
    markActivationSucceeded: async () => undefined,
    updateConfig: async () => undefined,
    updateVersion: async () => undefined,
  } as unknown as InstalledRegistry;
}

const noopVault = {
  setMany: async () => undefined,
  getMany: async () => ({}),
  purge: async () => undefined,
  list: async () => [],
} as unknown as SecretVault;

function recordingRegistrar(): PluginTemplateRegistrar & {
  registered: Array<{ pluginId: string; ids: string[] }>;
  unregistered: string[];
} {
  const registered: Array<{ pluginId: string; ids: string[] }> = [];
  const unregistered: string[] = [];
  return {
    registered,
    unregistered,
    registerPluginTemplates: (pluginId, manifests) => {
      registered.push({ pluginId, ids: manifests.map((m) => m.id) });
    },
    unregisterPluginTemplates: (pluginId) => {
      unregistered.push(pluginId);
    },
  };
}

describe('InstallService × plugin templates (#478)', () => {
  it('gated manifests register on install and unregister on uninstall', async () => {
    const root = await makePackage({ 'templates/approval.json': JSON.stringify(strictManifest()) });
    const registry = makeRegistry();
    const registrar = recordingRegistrar();
    const service = new InstallService({
      catalog: makeCatalog(PLUGIN_ID, root, ['templates/approval.json']),
      registry,
      vault: noopVault,
      conductorTemplates: () => registrar,
    });

    const job = service.create(PLUGIN_ID);
    const configured = await service.configure(job.id, {});
    assert.equal(configured.state, 'active');
    assert.ok(registry.has(PLUGIN_ID));
    assert.deepEqual(registrar.registered, [{ pluginId: PLUGIN_ID, ids: [`plugin:${PLUGIN_ID}:approval`] }]);

    await service.uninstall(PLUGIN_ID);
    assert.ok(!registry.has(PLUGIN_ID));
    assert.deepEqual(registrar.unregistered, [PLUGIN_ID]);
  });

  it('a strict-mode violation FAILS the install before anything is persisted', async () => {
    const bad = strictManifest();
    bad.graph.steps[0]!.agentId = 'install-local-agent';
    const root = await makePackage({ 'templates/bad.json': JSON.stringify(bad) });
    const registry = makeRegistry();
    const registrar = recordingRegistrar();
    const service = new InstallService({
      catalog: makeCatalog(PLUGIN_ID, root, ['templates/bad.json']),
      registry,
      vault: noopVault,
      conductorTemplates: () => registrar,
    });

    const job = service.create(PLUGIN_ID);
    const configured = await service.configure(job.id, {});
    assert.equal(configured.state, 'failed');
    assert.equal(configured.error?.code, 'install.template_invalid');
    const details = configured.error?.details as string[];
    assert.ok(details.some((d) => d.includes('template_concrete_ref_in_strict_mode')), JSON.stringify(details));
    assert.ok(!registry.has(PLUGIN_ID), 'a refused install must not land in the registry');
    assert.deepEqual(registrar.registered, []);
  });

  it('the validation gate runs even without a wired registrar (registration deferred to boot)', async () => {
    const bad = strictManifest();
    bad.graph.steps[0]!.agentId = 'install-local-agent';
    const root = await makePackage({ 'templates/bad.json': JSON.stringify(bad) });
    const service = new InstallService({
      catalog: makeCatalog(PLUGIN_ID, root, ['templates/bad.json']),
      registry: makeRegistry(),
      vault: noopVault,
      // no conductorTemplates dep at all
    });
    const job = service.create(PLUGIN_ID);
    assert.equal((await service.configure(job.id, {})).state, 'failed');

    const okRoot = await makePackage({ 'templates/approval.json': JSON.stringify(strictManifest()) });
    const okService = new InstallService({
      catalog: makeCatalog(PLUGIN_ID, okRoot, ['templates/approval.json']),
      registry: makeRegistry(),
      vault: noopVault,
    });
    const okJob = okService.create(PLUGIN_ID);
    assert.equal((await okService.configure(okJob.id, {})).state, 'active');
  });
});

describe('registerInstalledPluginTemplates — boot sweep', () => {
  it('re-registers templates of installed plugins; a bad template logs and skips, never throws', async () => {
    const root = await makePackage({
      'templates/ok.json': JSON.stringify(strictManifest()),
      'templates/broken.json': '{ not json',
    });
    const registry = makeRegistry();
    await registry.register({
      id: PLUGIN_ID,
      installed_version: '0.1.0',
      installed_at: '2026-07-10T00:00:00Z',
      status: 'active',
      config: {},
    });
    const registrar = recordingRegistrar();
    const logs: string[] = [];

    await registerInstalledPluginTemplates({
      catalog: makeCatalog(PLUGIN_ID, root, ['templates/ok.json', 'templates/broken.json']),
      registry,
      registrar,
      log: (m) => logs.push(m),
    });

    assert.deepEqual(registrar.registered, [{ pluginId: PLUGIN_ID, ids: [`plugin:${PLUGIN_ID}:approval`] }]);
    assert.ok(logs.some((l) => l.includes('template skipped')), JSON.stringify(logs));
  });

  it('is a no-op for installed plugins without template declarations', async () => {
    const root = await makePackage({});
    const registry = makeRegistry();
    await registry.register({
      id: PLUGIN_ID,
      installed_version: '0.1.0',
      installed_at: '2026-07-10T00:00:00Z',
      status: 'active',
      config: {},
    });
    const registrar = recordingRegistrar();
    await registerInstalledPluginTemplates({
      catalog: makeCatalog(PLUGIN_ID, root, []),
      registry,
      registrar,
      log: () => undefined,
    });
    assert.deepEqual(registrar.registered, []);
  });
});
