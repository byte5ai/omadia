/**
 * Spec 2042 §5.10, §6 criterion 15 — what a plugin delivers, and the
 * agent/plugin boundary at ingest.
 *
 *   - a manifest declaring a persona or speaker of its own, or kind `agent`,
 *     is rejected;
 *   - a channel plugin transporting two agents' bots and an agent template
 *     with a personality load;
 *   - an update of an installed `agent` package still enters (expand step),
 *     no other package becomes one.
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import yazl from 'yazl';

import {
  CAPABILITY_PLUGIN_KINDS,
  effectiveKind,
  installNeedsConfirmation,
  isInstallableKind,
  PLUGIN_KINDS,
  type PluginKind,
} from '../src/api/admin-v1.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { checkPluginBoundary } from '../src/plugins/pluginBoundary.js';
import { isDataOnlyPlugin } from '../src/plugins/pluginRuntimeOf.js';
import type { UploadedPackage, UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';

describe('spec 2042 §5.10 — plugin kinds', () => {
  it('knows the delivery kinds and the two retired ones, nothing else', () => {
    assert.deepEqual([...PLUGIN_KINDS].sort(), [
      'agent',
      'agent-template',
      'archetype',
      'channel',
      'extension',
      'integration',
      'model',
      'skill',
      'system-module',
      'tool',
    ]);
    assert.ok(!(PLUGIN_KINDS as readonly string[]).includes('provider'));
    assert.ok(!(PLUGIN_KINDS as readonly string[]).includes('ui'));
  });

  it('only capabilities are granted to agents', () => {
    assert.deepEqual([...CAPABILITY_PLUGIN_KINDS].sort(), ['integration', 'skill', 'tool']);
  });

  it('reads the retired `extension` as a system module, every other kind as itself', () => {
    assert.equal(effectiveKind('extension'), 'system-module');
    for (const kind of PLUGIN_KINDS.filter((k) => k !== 'extension')) assert.equal(effectiveKind(kind), kind);
  });

  it('never installs kind `agent` anew; asks before an archetype or a system module', () => {
    assert.equal(isInstallableKind('agent'), false);
    for (const kind of PLUGIN_KINDS.filter((k) => k !== 'agent')) assert.equal(isInstallableKind(kind), true);
    assert.deepEqual(PLUGIN_KINDS.filter(installNeedsConfirmation).sort(), ['archetype', 'system-module']);
  });

  it('an agent template is data only; a skill package is when it ships no code', () => {
    assert.equal(isDataOnlyPlugin('agent-template', {}), true);
    assert.equal(isDataOnlyPlugin('skill', { lifecycle: {} }), true);
    assert.equal(isDataOnlyPlugin('skill', { lifecycle: { entry: 'dist/plugin.js' } }), false);
    assert.equal(isDataOnlyPlugin('tool', {}), false);
  });
});

describe('spec 2042 §5.10 — checkPluginBoundary', () => {
  const base = { pluginId: '@t/p', hasAgentMd: false, installedKind: undefined } as const;

  it('refuses kind `agent` that is not installed, with the plugin id for the client', () => {
    const v = checkPluginBoundary({ ...base, kind: 'agent', manifest: {} });
    assert.equal(v?.code, 'package.retired_kind');
    assert.deepEqual(v?.params, { pluginId: '@t/p' });
  });

  it('lets the update of an installed `agent` package in, and no package becomes one', () => {
    assert.equal(checkPluginBoundary({ ...base, kind: 'agent', manifest: {}, installedKind: 'agent' }), undefined);
    assert.equal(
      checkPluginBoundary({ ...base, kind: 'agent', manifest: {}, installedKind: 'tool' })?.code,
      'package.retired_kind',
    );
  });

  for (const [label, manifest] of [
    ['a persona block', { persona: { tone: 'warm' } }],
    ['a speaker', { speaker: { name: 'Mira' } }],
    ['identity.persona', { identity: { persona: 'Mira' } }],
    ['a system prompt', { system_prompt: 'You are Mira' }],
    ['a prompt_partial skill', { skills: [{ id: 's', kind: 'prompt_partial', path: 'skills/x.md' }] }],
  ] as const) {
    it(`refuses ${label} in a capability plugin`, () => {
      const v = checkPluginBoundary({ ...base, kind: 'integration', manifest });
      assert.equal(v?.code, 'package.persona_declared');
      assert.ok(v?.params['field']);
    });
  }

  it('refuses an AGENT.md persona file outside an agent template', () => {
    assert.equal(
      checkPluginBoundary({ ...base, kind: 'tool', manifest: {}, hasAgentMd: true })?.code,
      'package.persona_declared',
    );
    assert.equal(checkPluginBoundary({ ...base, kind: 'agent-template', manifest: {}, hasAgentMd: true }), undefined);
  });

  it('lets an agent template with a personality in: inactive presets', () => {
    const manifest = {
      agent_templates: [{ id: 'hr', name: 'Hanna', instructions: 'You are the HR colleague.', persona: { axes: { warmth: 80 } } }],
    };
    assert.equal(checkPluginBoundary({ ...base, kind: 'agent-template', manifest }), undefined);
    assert.equal(checkPluginBoundary({ ...base, kind: 'integration', manifest }), undefined);
  });

  it('lets a channel plugin that transports several agents’ bots in', () => {
    const manifest = {
      channel: { transport: { kind: 'webhook' }, identities: 'per-agent' },
      playbook: { when_to_use: 'Teams' },
    };
    assert.equal(checkPluginBoundary({ ...base, kind: 'channel', manifest }), undefined);
  });
});

// --- ingest ----------------------------------------------------------------

function buildZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf-8'), name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

function manifest(kind: PluginKind, extra = '', withEntry = true): string {
  return `schema_version: "1"

identity:
  id: "@test/boundary"
  name: "Boundary"
  version: "1.0.0"
  kind: "${kind}"
  description: "Fixture plugin for boundary tests."

compat:
  core: ">=1.0 <2.0"
${withEntry ? '\nlifecycle:\n  entry: "dist/plugin.js"\n' : ''}${extra}`;
}

function fakeStore(): UploadedPackageStore {
  const packages = new Map<string, UploadedPackage>();
  return {
    get: (id: string) => packages.get(id),
    has: (id: string) => packages.has(id),
    list: () => [...packages.values()],
    register: async (pkg: UploadedPackage) => {
      packages.set(pkg.id, pkg);
    },
  } as unknown as UploadedPackageStore;
}

function catalogWith(kind?: PluginKind): PluginCatalog {
  return {
    get: (id: string) => (kind && id === '@test/boundary' ? { plugin: { id, kind } } : undefined),
    load: async () => undefined,
    list: () => [],
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

describe('spec 2042 §6 criterion 15 — the boundary at ingest', () => {
  let packagesDir: string;
  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boundary-test-'));
  });
  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  async function ingest(
    files: Record<string, string>,
    installed?: PluginKind,
  ): Promise<{ ok: boolean; code?: string; params?: unknown }> {
    const registry = new InMemoryInstalledRegistry();
    if (installed) {
      await registry.register({
        id: '@test/boundary',
        installed_version: '0.9.0',
        installed_at: '2026-11-01T00:00:00.000Z',
        status: 'active',
        config: {},
      });
    }
    const store = fakeStore();
    if (installed) {
      // The installed version came in through an earlier upload.
      const dir = path.join(packagesDir, '@test/boundary', '0.9.0');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'manifest.yaml'), manifest(installed).replace('1.0.0', '0.9.0'));
      await store.register({
        id: '@test/boundary',
        version: '0.9.0',
        path: dir,
        uploaded_at: '2026-11-01T00:00:00.000Z',
        uploaded_by: 'seed@example.com',
        sha256: 'a'.repeat(64),
        peers_missing: [],
        zip_bytes: 1,
        extracted_bytes: 1,
        file_count: 1,
      } as UploadedPackage);
    }
    const svc = new PackageUploadService({
      store,
      catalog: catalogWith(installed),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      registry,
      log: () => undefined,
    });
    return (await svc.ingest({
      fileBuffer: await buildZip(files),
      originalFilename: 'boundary.zip',
      uploadedBy: 'operator@example.com',
    })) as { ok: boolean; code?: string; params?: unknown };
  }

  const code = { 'dist/plugin.js': 'export async function activate() { return { close: async () => {} }; }\n' };

  it('rejects a package of kind `agent`', async () => {
    const r = await ingest({ 'manifest.yaml': manifest('agent'), ...code });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'package.retired_kind');
  });

  it('rejects a capability plugin that declares a persona', async () => {
    const r = await ingest({ 'manifest.yaml': manifest('integration', 'persona:\n  tone: "warm"\n'), ...code });
    assert.equal(r.code, 'package.persona_declared');
    assert.deepEqual(r.params, { pluginId: '@test/boundary', field: 'persona' });
  });

  it('rejects a tool that ships an AGENT.md', async () => {
    const r = await ingest({ 'manifest.yaml': manifest('tool'), 'AGENT.md': '---\nname: Mira\n---\n', ...code });
    assert.equal(r.code, 'package.persona_declared');
  });

  it('accepts an agent template with a personality and no code', async () => {
    const templates = 'agent_templates:\n  - id: "hr"\n    name: "Hanna"\n    instructions: "You are the HR colleague."\n    persona:\n      axes:\n        warmth: 80\n';
    const r = await ingest({ 'manifest.yaml': manifest('agent-template', templates, false), 'AGENT.md': 'x' });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('accepts a channel plugin', async () => {
    const r = await ingest({ 'manifest.yaml': manifest('channel'), ...code });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('accepts the update of an installed `agent` package (expand step)', async () => {
    const r = await ingest({ 'manifest.yaml': manifest('agent'), ...code }, 'agent');
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});
