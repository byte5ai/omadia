import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { DraftStore } from '../src/plugins/builder/draftStore.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { zipProfileBundle } from '../src/plugins/profileBundleZipper.js';
import {
  UploadedPackageStore,
  type UploadedPackage,
} from '../src/plugins/uploadedPackageStore.js';
import type { LiveProfileStorageService } from '../src/profileStorage/liveProfileStorageService.js';
import { createProfilesRouter } from '../src/routes/profiles.js';

/**
 * Phase 2.4 — POST /api/v1/profiles/import-bundle (OB-66) end-to-end tests.
 *
 * Scope:
 *   - Roundtrip: zipProfileBundle output → POST → DraftStore row
 *     materialised, agent.md + knowledge written, spec_source reflects
 *     spec.json vs agent.md fallback path
 *   - Reject paths from BundleImporter (unknown plugin, hash mismatch)
 *     surface with the importer's stable code
 *   - Vendored-plugin install: PackageUploadService.ingest called
 *   - Profile-target overwrite handshake: 409 without flag, 200 with
 *
 * Storage stub mirrors profilesSnapshotsRouter.test.ts; DraftStore uses a
 * real SQLite file in a tmpdir so the import wiring exercises the real
 * mirror-hook + schema path.
 */

const TEST_PLUGIN_ID = 'harness-plugin-import-fixture';
const TEST_PLUGIN_VERSION = '1.0.0';
const TEST_PLUGIN_SHA = 'a'.repeat(64);
const FIXTURE_AGENT_MD = `# Test Agent\n\nAntworte knapp.\n`;

interface StorageCapture {
  setAgentMd: Array<{ id: string; content: Buffer; updatedBy: string }>;
  setKnowledgeFile: Array<{ id: string; filename: string; content: Buffer }>;
  agentMdRecords: Map<string, Buffer>;
  knowledgeRecords: Map<string, Map<string, Buffer>>;
}

function makeStorageStub(): {
  storage: LiveProfileStorageService;
  capture: StorageCapture;
} {
  const capture: StorageCapture = {
    setAgentMd: [],
    setKnowledgeFile: [],
    agentMdRecords: new Map(),
    knowledgeRecords: new Map(),
  };
  const storage = {
    async getAgentMd(profileId: string) {
      const buf = capture.agentMdRecords.get(profileId);
      if (!buf) return null;
      return {
        content: buf,
        sha256: shaHex(buf),
        sizeBytes: buf.byteLength,
        updatedAt: new Date(),
        updatedBy: 'stub',
      };
    },
    async setAgentMd(profileId: string, content: Buffer, updatedBy: string) {
      capture.setAgentMd.push({ id: profileId, content, updatedBy });
      capture.agentMdRecords.set(profileId, content);
      return {
        content,
        sha256: shaHex(content),
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
        updatedBy,
      };
    },
    async listKnowledge(profileId: string) {
      const files = capture.knowledgeRecords.get(profileId) ?? new Map();
      return Array.from(files.entries()).map(([filename, buf]) => ({
        filename,
        sha256: shaHex(buf as Buffer),
        sizeBytes: (buf as Buffer).byteLength,
        updatedAt: new Date(),
      }));
    },
    async getKnowledgeFile(profileId: string, filename: string) {
      const files = capture.knowledgeRecords.get(profileId);
      const buf = files?.get(filename);
      if (!buf) return null;
      return {
        filename,
        content: buf,
        sha256: shaHex(buf),
        sizeBytes: buf.byteLength,
        updatedAt: new Date(),
        updatedBy: 'stub',
      };
    },
    async setKnowledgeFile(
      profileId: string,
      filename: string,
      content: Buffer,
    ) {
      capture.setKnowledgeFile.push({ id: profileId, filename, content });
      let files = capture.knowledgeRecords.get(profileId);
      if (!files) {
        files = new Map();
        capture.knowledgeRecords.set(profileId, files);
      }
      files.set(filename, content);
      return {
        filename,
        sha256: shaHex(content),
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
      };
    },
    async removeKnowledgeFile(profileId: string, filename: string) {
      const files = capture.knowledgeRecords.get(profileId);
      const removed = files?.delete(filename) ?? false;
      return { removed };
    },
  } as unknown as LiveProfileStorageService;
  return { storage, capture };
}

function shaHex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeUploadedPackage(overrides: Partial<UploadedPackage> = {}): UploadedPackage {
  return {
    id: TEST_PLUGIN_ID,
    version: TEST_PLUGIN_VERSION,
    path: '/tmp/fake-plugin-path',
    uploaded_at: '2026-05-08T10:00:00.000Z',
    uploaded_by: 'test@example.com',
    sha256: TEST_PLUGIN_SHA,
    peers_missing: [],
    zip_bytes: 0,
    extracted_bytes: 0,
    file_count: 0,
    ...overrides,
  };
}

function makeCatalogStub(): PluginCatalog {
  return { get: () => undefined, list: () => [] } as unknown as PluginCatalog;
}

interface IngestRecord {
  fileBuffer: Buffer;
  originalFilename: string;
  uploadedBy: string;
  sha256?: string;
}

function makeUploadServiceStub(opts: {
  onIngest?: (input: IngestRecord) => void;
} = {}): PackageUploadService {
  return {
    ingest: async (input: IngestRecord) => {
      opts.onIngest?.(input);
      return {
        ok: true as const,
        package: makeUploadedPackage({ id: input.originalFilename }),
        plugin_id: TEST_PLUGIN_ID,
        version: TEST_PLUGIN_VERSION,
      };
    },
  } as unknown as PackageUploadService;
}

async function uploadBundle(
  baseUrl: string,
  buffer: Buffer,
  fields: Record<string, string> = {},
  filename = 'bundle.zip',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new Blob([buffer], { type: 'application/zip' }), filename);
  const res = await fetch(`${baseUrl}/api/v1/profiles/import-bundle`, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

describe('POST /api/v1/profiles/import-bundle', () => {
  let server: Server;
  let baseUrl: string;
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let draftStore: DraftStore;
  let storageStub: ReturnType<typeof makeStorageStub>;
  let uploadServiceCalls: IngestRecord[];

  before(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'profile-import-route-test-'));
  });

  beforeEach(async () => {
    const indexPath = join(tmpRoot, 'index.json');
    const pkgDir = join(tmpRoot, 'packages');
    await fs.rm(indexPath, { force: true });
    await fs.rm(pkgDir, { recursive: true, force: true });
    store = new UploadedPackageStore(indexPath, pkgDir);
    await store.load();
    await store.register(makeUploadedPackage());

    const draftDb = join(tmpRoot, `drafts-${Date.now()}.db`);
    draftStore = new DraftStore({ dbPath: draftDb });
    await draftStore.open();

    storageStub = makeStorageStub();
    uploadServiceCalls = [];

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    // Inject a fake session so actorOf returns a real email.
    app.use((req, _res, next) => {
      (req as unknown as { session: { email: string } }).session = {
        email: 'op@example.com',
      };
      next();
    });
    app.use(
      '/api/v1/profiles',
      createProfilesRouter({
        catalog: makeCatalogStub(),
        registry: new InMemoryInstalledRegistry(),
        liveStorage: storageStub.storage,
        draftStore,
        uploadedPackageStore: store,
        packageUploadService: makeUploadServiceStub({
          onIngest: (rec) => {
            uploadServiceCalls.push(rec);
          },
        }),
      }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await draftStore.close();
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('roundtrip: bundle with spec.json → draft created, spec_source=spec_json', async () => {
    const specJson = JSON.stringify({
      template: 'agent-integration',
      id: 'de.byte5.agent.import-test',
      name: 'Imported Agent',
      version: '1.0.0',
      description: 'Roundtrip fixture',
      category: 'productivity',
      depends_on: [],
      tools: [],
      skill: { role: 'Hilf knapp.' },
      setup_fields: [],
      playbook: {
        when_to_use: 'beim Test',
        not_for: [],
        example_prompts: [],
      },
      network: { outbound: [] },
      external_reads: [],
      slots: {},
      builder_settings: { auto_fix_enabled: false },
      test_cases: [],
    });
    const bundle = await zipProfileBundle(
      { store },
      {
        profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileName: 'Imported Agent',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        knowledge: [
          { filename: 'spec.json', content: Buffer.from(specJson, 'utf8') },
          { filename: 'style.md', content: Buffer.from('# Style\nKurz.', 'utf8') },
        ],
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );

    const res = await uploadBundle(baseUrl, bundle.buffer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);
    assert.equal(res.body['imported_as'], 'draft');
    assert.equal(res.body['spec_source'], 'spec_json');
    assert.equal(typeof res.body['draft_id'], 'string');
    const draftId = res.body['draft_id'] as string;

    const draft = await draftStore.findById(draftId);
    assert.ok(draft, 'draft row created');
    assert.equal(draft!.spec.id, 'de.byte5.agent.import-test');
    assert.equal(draft!.name, 'Imported Agent');

    // agent.md + non-spec knowledge files written to live storage under
    // the new draft.id — the draft_id == profile_id invariant is what
    // the snapshot pipeline keys off later.
    assert.equal(
      storageStub.capture.setAgentMd.length,
      1,
      'setAgentMd called exactly once',
    );
    assert.equal(storageStub.capture.setAgentMd[0]!.id, draftId);
    const knowledgeWrites = storageStub.capture.setKnowledgeFile.filter(
      (w) => w.id === draftId,
    );
    // spec.json must NOT land in profile_knowledge_file — it has already
    // been used to reconstruct the spec field on the draft itself.
    assert.equal(
      knowledgeWrites.some((w) => w.filename === 'spec.json'),
      false,
      'spec.json must not be persisted as a knowledge file',
    );
    assert.equal(
      knowledgeWrites.some((w) => w.filename === 'style.md'),
      true,
      'non-spec knowledge files are persisted',
    );
  });

  it('source-only bundle (no spec.json) → spec_source=agent_md_fallback', async () => {
    const bundle = await zipProfileBundle(
      { store },
      {
        profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        profileName: 'Source-Only Agent',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );
    const res = await uploadBundle(baseUrl, bundle.buffer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['spec_source'], 'agent_md_fallback');
  });

  it('rejects bundle with unknown plugin (400 bundle.unknown_plugin)', async () => {
    // Build the bundle on a separate store that knows the plugin, then
    // import via a fresh server whose store is empty — exactly the
    // cross-instance scenario.
    const sourceStore = store; // already has the fixture plugin
    const bundle = await zipProfileBundle(
      { store: sourceStore },
      {
        profileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        profileName: 'Unknown-Plugin Agent',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );

    // Fresh server with EMPTY upload store.
    const emptyStore = new UploadedPackageStore(
      join(tmpRoot, 'empty-index.json'),
      join(tmpRoot, 'empty-pkg'),
    );
    await emptyStore.load();
    const altApp = express();
    altApp.use(express.json({ limit: '1mb' }));
    altApp.use((req, _res, next) => {
      (req as unknown as { session: { email: string } }).session = {
        email: 'op@example.com',
      };
      next();
    });
    altApp.use(
      '/api/v1/profiles',
      createProfilesRouter({
        catalog: makeCatalogStub(),
        registry: new InMemoryInstalledRegistry(),
        liveStorage: storageStub.storage,
        draftStore,
        uploadedPackageStore: emptyStore,
      }),
    );
    const altServer = altApp.listen(0);
    const altPort = (altServer.address() as AddressInfo).port;
    try {
      const res = await uploadBundle(
        `http://127.0.0.1:${String(altPort)}`,
        bundle.buffer,
      );
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body['code'], 'bundle.unknown_plugin');
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()));
    }
  });

  it('rejects bundle with manipulated spec.json (400 bundle.invalid_spec_json)', async () => {
    const badSpecJson = JSON.stringify({
      template: 'agent-integration',
      id: 'de.byte5.agent.bad',
      name: 'Bad',
      version: '1.0.0',
      description: 'Schema-drift fixture',
      category: 'not-a-real-category',
      depends_on: [],
      tools: [],
      skill: { role: 'role' },
      setup_fields: [],
      playbook: { when_to_use: 'now', not_for: [], example_prompts: [] },
      network: { outbound: [] },
      external_reads: [],
      slots: {},
      builder_settings: { auto_fix_enabled: false },
      test_cases: [],
    });
    const bundle = await zipProfileBundle(
      { store },
      {
        profileId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        profileName: 'Bad-Spec Agent',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        knowledge: [
          { filename: 'spec.json', content: Buffer.from(badSpecJson, 'utf8') },
        ],
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );
    const res = await uploadBundle(baseUrl, bundle.buffer);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body['code'], 'bundle.invalid_spec_json');
  });

  it('profile-target overwrite handshake: 409 without flag, 200 with', async () => {
    // Pre-populate live storage so the import would diverge.
    await storageStub.storage.setAgentMd(
      'production',
      Buffer.from('# existing live content', 'utf8'),
      'op@example.com',
    );

    const bundle = await zipProfileBundle(
      { store },
      {
        profileId: 'production',
        profileName: 'Production',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD, // different from existing
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );

    const conflictRes = await uploadBundle(baseUrl, bundle.buffer, {
      target: 'profile',
    });
    assert.equal(conflictRes.status, 409, JSON.stringify(conflictRes.body));
    assert.equal(conflictRes.body['code'], 'bundle.import_conflict');
    assert.deepEqual(
      (conflictRes.body['diverged_assets'] as string[]).sort(),
      ['agent.md'],
    );

    const okRes = await uploadBundle(baseUrl, bundle.buffer, {
      target: 'profile',
      overwrite: 'true',
    });
    assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
    assert.equal(okRes.body['imported_as'], 'profile');
    assert.equal(okRes.body['profile_id'], 'production');
    // The first overwrite-write replaced the existing agent.md, so the
    // post-write live state matches the bundle and no further drift.
  });

  it('rejects upload with missing file (400 bundle.upload_no_file)', async () => {
    const form = new FormData();
    form.set('target', 'draft');
    const res = await fetch(`${baseUrl}/api/v1/profiles/import-bundle`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'bundle.upload_no_file');
  });
});
