import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import express from 'express';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createProfilesRouter } from '../src/routes/profiles.js';
import type {
  AssetDiff,
  CreateSnapshotInput,
  CreateSnapshotResult,
  DiffInput,
  MarkDeployReadyInput,
  RollbackInput,
  RollbackResult,
  SnapshotDetail,
  SnapshotService,
  SnapshotSummary,
} from '../src/profileSnapshots/snapshotService.js';
import {
  SnapshotNotFoundError,
  SnapshotValidationError,
} from '../src/profileSnapshots/snapshotService.js';
import type { LiveProfileStorageService } from '../src/profileStorage/liveProfileStorageService.js';

/**
 * Phase 2.2-D — HTTP routes for profile snapshots.
 *
 * Tested behaviours:
 *   - Snapshot guard: routes 503 when service is missing
 *   - Snapshot create: writes audit when wasExisting=false; not when true
 *   - Mark-deploy-ready: cross-profile reject, audit on success
 *   - Rollback: invokes storage writes via injected LiveProfileStorageService,
 *     audit payload contains diverged_assets
 *   - Diff: parses base/target query params (live or snapshot UUID)
 *
 * The SnapshotService surface is stubbed inline; the create+read SQL
 * layer is exercised exhaustively in profileSnapshots.test.ts.
 */

interface AuditCapture {
  entries: AuditEntryInput[];
}

function makeAuditStub(): { log: { record: (e: AuditEntryInput) => Promise<void>; list: () => Promise<[]> }; capture: AuditCapture } {
  const capture: AuditCapture = { entries: [] };
  const log = {
    record: async (e: AuditEntryInput) => {
      capture.entries.push(e);
    },
    list: async () => [],
  };
  return { log, capture };
}

interface StorageCapture {
  setAgentMd: Array<{ id: string; content: Buffer; updatedBy: string }>;
  setKnowledgeFile: Array<{ id: string; filename: string; content: Buffer }>;
  removed: Array<{ id: string; filename: string }>;
  liveKnowledge: string[];
}

function makeStorageStub(initialLiveKnowledge: string[] = []): {
  storage: LiveProfileStorageService;
  capture: StorageCapture;
} {
  const capture: StorageCapture = {
    setAgentMd: [],
    setKnowledgeFile: [],
    removed: [],
    liveKnowledge: [...initialLiveKnowledge],
  };
  const storage = {
    async setAgentMd(profileId: string, content: Buffer, updatedBy: string) {
      capture.setAgentMd.push({ id: profileId, content, updatedBy });
      return {
        content,
        sha256: 'stub',
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
        updatedBy,
      };
    },
    async setKnowledgeFile(
      profileId: string,
      filename: string,
      content: Buffer,
    ) {
      capture.setKnowledgeFile.push({ id: profileId, filename, content });
      if (!capture.liveKnowledge.includes(filename)) capture.liveKnowledge.push(filename);
      return {
        filename,
        sha256: 'stub',
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
      };
    },
    async listKnowledge() {
      return capture.liveKnowledge.map((filename) => ({
        filename,
        sha256: 'stub',
        sizeBytes: 0,
        updatedAt: new Date(),
      }));
    },
    async removeKnowledgeFile(profileId: string, filename: string) {
      capture.removed.push({ id: profileId, filename });
      capture.liveKnowledge = capture.liveKnowledge.filter((f) => f !== filename);
      return { removed: true };
    },
  } as unknown as LiveProfileStorageService;
  return { storage, capture };
}

interface SnapshotStubConfig {
  detail?: SnapshotDetail;
  /** When set, getSnapshot returns this regardless of id. Set null to force 404. */
  override?: SnapshotDetail | null;
  diffOverride?: AssetDiff[];
}

function makeSnapshotStub(cfg: SnapshotStubConfig): SnapshotService {
  const stub = {
    async createSnapshot(input: CreateSnapshotInput): Promise<CreateSnapshotResult> {
      if (input.profileId === 'force-existing') {
        return {
          snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          bundleHash: 'h'.repeat(64),
          bundleSizeBytes: 100,
          createdAt: new Date('2026-05-08T10:00:00Z'),
          wasExisting: true,
        };
      }
      return {
        snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        bundleHash: 'h'.repeat(64),
        bundleSizeBytes: 200,
        createdAt: new Date('2026-05-08T10:00:00Z'),
        wasExisting: false,
      };
    },
    async listSnapshots(): Promise<SnapshotSummary[]> {
      if (!cfg.detail) return [];
      return [summaryOf(cfg.detail)];
    },
    async getSnapshot(snapshotId: string): Promise<SnapshotDetail | null> {
      if (cfg.override !== undefined) return cfg.override;
      if (!cfg.detail) return null;
      return cfg.detail.snapshotId === snapshotId ? cfg.detail : null;
    },
    async getAssetBytes() {
      return Buffer.from('stub asset');
    },
    async assembleBundle() {
      return Buffer.from('PK\x03\x04 stub-zip-bytes');
    },
    async markDeployReady(input: MarkDeployReadyInput): Promise<SnapshotSummary> {
      if (!cfg.detail || cfg.detail.snapshotId !== input.snapshotId) {
        throw new SnapshotNotFoundError(input.snapshotId);
      }
      const next: SnapshotDetail = {
        ...cfg.detail,
        isDeployReady: true,
        deployReadyAt: new Date('2026-05-08T11:00:00Z'),
        deployReadyBy: input.operator,
      };
      cfg.detail = next;
      return summaryOf(next);
    },
    async rollback(input: RollbackInput): Promise<RollbackResult> {
      if (!cfg.detail || cfg.detail.snapshotId !== input.snapshotId) {
        throw new SnapshotNotFoundError(input.snapshotId);
      }
      // Simulate the storage writes via onPersist
      await input.onPersist({
        manifest: {
          harness: { bundleSpec: 1 },
          profile: {
            id: cfg.detail.profileId,
            name: 'Demo',
            version: '1.0.0',
            created_at: '2026-05-08T10:00:00.000Z',
            created_by: 'op@example.com',
          },
          agent: { file: 'agent.md', sha256: 'a'.repeat(64) },
          plugins: [],
          knowledge: [],
          bundle_hash: cfg.detail.bundleHash,
        },
        agentMd: Buffer.from('# Restored\n', 'utf8'),
        knowledge: [
          { filename: 'knowledge/style.md', content: Buffer.from('s', 'utf8') },
        ],
        plugins: [],
      });
      return {
        rolledBackTo: {
          snapshotId: input.snapshotId,
          bundleHash: cfg.detail.bundleHash,
        },
        appliedAt: new Date('2026-05-08T12:00:00Z'),
        divergedAssets: ['agent.md'],
      };
    },
    async diff(input: DiffInput): Promise<AssetDiff[]> {
      if (cfg.diffOverride) return cfg.diffOverride;
      void input;
      return [
        {
          path: 'agent.md',
          status: 'identical',
          baseSha256: 'a'.repeat(64),
          targetSha256: 'a'.repeat(64),
        },
      ];
    },
  };
  return stub as unknown as SnapshotService;
}

function summaryOf(d: SnapshotDetail): SnapshotSummary {
  return {
    snapshotId: d.snapshotId,
    profileId: d.profileId,
    profileVersion: d.profileVersion,
    bundleHash: d.bundleHash,
    bundleSizeBytes: d.bundleSizeBytes,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    notes: d.notes,
    isDeployReady: d.isDeployReady,
    deployReadyAt: d.deployReadyAt,
    deployReadyBy: d.deployReadyBy,
  };
}

function makeDetail(): SnapshotDetail {
  return {
    snapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    profileId: 'demo-bot',
    profileVersion: '1.0.0',
    bundleHash: 'd'.repeat(64),
    bundleSizeBytes: 1024,
    createdAt: new Date('2026-05-08T10:00:00Z'),
    createdBy: 'op@example.com',
    notes: null,
    isDeployReady: false,
    deployReadyAt: null,
    deployReadyBy: null,
    manifestYaml: 'harness:\n  bundleSpec: 1\n',
    assets: [
      { path: 'agent.md', sha256: 'a'.repeat(64), sizeBytes: 100 },
      { path: 'knowledge/style.md', sha256: 'b'.repeat(64), sizeBytes: 50 },
    ],
    driftScore: 0,
  };
}

const emptyCatalog = {
  get: () => undefined,
  list: () => [],
} as unknown as PluginCatalog;

interface Harness {
  baseUrl: string;
  audit: AuditCapture;
  storage: StorageCapture;
  close: () => Promise<void>;
}

async function startHarness(opts: {
  detail?: SnapshotDetail;
  override?: SnapshotDetail | null;
  diffOverride?: AssetDiff[];
  withSnapshot?: boolean;
  withAudit?: boolean;
  initialLiveKnowledge?: string[];
}): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'snap-routes-'));
  const registry = new InMemoryInstalledRegistry();
  const audit = makeAuditStub();
  const stor = makeStorageStub(opts.initialLiveKnowledge);

  const router = createProfilesRouter({
    catalog: emptyCatalog,
    registry,
    profilesDir: tmpDir,
    liveStorage: stor.storage,
    ...(opts.withSnapshot !== false
      ? {
          snapshotService: makeSnapshotStub({
            detail: opts.detail,
            ...(opts.override !== undefined ? { override: opts.override } : {}),
            ...(opts.diffOverride !== undefined ? { diffOverride: opts.diffOverride } : {}),
          }),
        }
      : {}),
    ...(opts.withAudit !== false ? { auditLog: audit.log as never } : {}),
  });

  const app = express();
  // simulate the operator session middleware
  app.use((req, _res, next) => {
    (req as { session?: { email?: string } }).session = { email: 'op@example.com' };
    next();
  });
  app.use(express.json());
  app.use('/api/v1/profiles', router);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    audit: audit.capture,
    storage: stor.capture,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('/api/v1/profiles/:id/snapshot[s] routes', () => {
  let harness: Harness | undefined;

  after(async () => {
    if (harness) await harness.close();
  });

  it('returns 503 when snapshot service is not configured', async () => {
    const local = await startHarness({ withSnapshot: false });
    try {
      const res = await fetch(`${local.baseUrl}/api/v1/profiles/demo-bot/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'profile_snapshot.unavailable');
    } finally {
      await local.close();
    }
  });

  it('POST /:id/snapshot writes audit on new snapshot, omits audit when existing', async () => {
    const local = await startHarness({});
    try {
      const fresh = await fetch(`${local.baseUrl}/api/v1/profiles/demo-bot/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(fresh.status, 200);
      const freshBody = (await fresh.json()) as { was_existing: boolean };
      assert.equal(freshBody.was_existing, false);
      assert.equal(local.audit.entries.length, 1);
      assert.equal(local.audit.entries[0]!.action, 'profile_snapshot.create');

      const dup = await fetch(`${local.baseUrl}/api/v1/profiles/force-existing/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(dup.status, 200);
      const dupBody = (await dup.json()) as { was_existing: boolean };
      assert.equal(dupBody.was_existing, true);
      // No new audit entry — was_existing=true is a NOOP audit-wise
      assert.equal(local.audit.entries.length, 1);
    } finally {
      await local.close();
    }
  });

  it('GET /:id/snapshots/:sid rejects cross-profile snapshot id with 404', async () => {
    const detail = makeDetail();
    const local = await startHarness({ detail });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/other-bot/snapshots/${detail.snapshotId}`,
      );
      assert.equal(res.status, 404);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'profile_snapshot.not_found');
    } finally {
      await local.close();
    }
  });

  it('GET /:id/snapshots/:sid/download defaults to the inner plugin ZIP when present', async () => {
    const detail: SnapshotDetail = {
      ...makeDetail(),
      assets: [
        { path: 'agent.md', sha256: 'a'.repeat(64), sizeBytes: 100 },
        {
          path: 'plugins/de.byte5.demo-1.0.0.zip',
          sha256: 'p'.repeat(64),
          sizeBytes: 4096,
        },
      ],
    };
    const local = await startHarness({ detail });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/snapshots/${detail.snapshotId}/download`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const dispo = res.headers.get('content-disposition');
      assert.ok(dispo?.includes('attachment'));
      // Plugin-only default has no `-bundle` suffix.
      assert.equal(
        dispo?.includes('-bundle.zip'),
        false,
        `plugin-only default must not carry the -bundle.zip suffix; got: ${dispo}`,
      );
    } finally {
      await local.close();
    }
  });

  it('GET /:id/snapshots/:sid/download falls back to bundle when no plugin asset', async () => {
    // makeDetail() ships only agent.md + knowledge/style.md — no plugin asset.
    const detail = makeDetail();
    const local = await startHarness({ detail });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/snapshots/${detail.snapshotId}/download`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const dispo = res.headers.get('content-disposition');
      assert.ok(dispo?.includes('-bundle.zip'));
    } finally {
      await local.close();
    }
  });

  it('GET /:id/snapshots/:sid/download?format=bundle returns the full Profile-Bundle', async () => {
    const detail: SnapshotDetail = {
      ...makeDetail(),
      assets: [
        { path: 'agent.md', sha256: 'a'.repeat(64), sizeBytes: 100 },
        {
          path: 'plugins/de.byte5.demo-1.0.0.zip',
          sha256: 'p'.repeat(64),
          sizeBytes: 4096,
        },
      ],
    };
    const local = await startHarness({ detail });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/snapshots/${detail.snapshotId}/download?format=bundle`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const dispo = res.headers.get('content-disposition');
      assert.ok(
        dispo?.includes('-bundle.zip'),
        `bundle variant must carry the -bundle.zip suffix; got: ${dispo}`,
      );
    } finally {
      await local.close();
    }
  });

  it('POST /:id/snapshots/:sid/mark-deploy-ready writes audit + flips flag', async () => {
    const detail = makeDetail();
    const local = await startHarness({ detail });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/snapshots/${detail.snapshotId}/mark-deploy-ready`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { is_deploy_ready: boolean; deploy_ready_by: string };
      assert.equal(body.is_deploy_ready, true);
      assert.equal(body.deploy_ready_by, 'op@example.com');
      const auditEntry = local.audit.entries.find(
        (e) => e.action === 'profile_snapshot.mark_deploy_ready',
      );
      assert.ok(auditEntry, 'mark_deploy_ready audit row must exist');
    } finally {
      await local.close();
    }
  });

  it('POST /:id/rollback/:sid writes storage + audits diverged_assets', async () => {
    const detail = makeDetail();
    const local = await startHarness({
      detail,
      initialLiveKnowledge: ['stale.md', 'style.md'],
    });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/rollback/${detail.snapshotId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        diverged_assets: string[];
        rolled_back_to: { bundle_hash: string };
      };
      assert.deepEqual(body.diverged_assets, ['agent.md']);
      assert.equal(body.rolled_back_to.bundle_hash, detail.bundleHash);

      assert.equal(local.storage.setAgentMd.length, 1);
      assert.equal(local.storage.setKnowledgeFile.length, 1);
      // stale.md was live but not in snapshot → must be removed
      assert.ok(
        local.storage.removed.some((r) => r.filename === 'stale.md'),
        'stale.md must be removed during rollback',
      );

      const auditEntry = local.audit.entries.find(
        (e) => e.action === 'profile_snapshot.rollback',
      );
      assert.ok(auditEntry, 'rollback audit must be recorded');
      const after = auditEntry!.after as { diverged_assets: string[] };
      assert.deepEqual(after.diverged_assets, ['agent.md']);
    } finally {
      await local.close();
    }
  });

  it('GET /:id/diff parses live + snapshot sides via query params', async () => {
    const detail = makeDetail();
    const local = await startHarness({
      detail,
      diffOverride: [
        {
          path: 'agent.md',
          status: 'modified',
          baseSha256: 'a'.repeat(64),
          targetSha256: 'b'.repeat(64),
        },
      ],
    });
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/diff?base=${detail.snapshotId}&target=live`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { diffs: Array<{ status: string; path: string }> };
      assert.equal(body.diffs.length, 1);
      assert.equal(body.diffs[0]!.status, 'modified');
      assert.equal(body.diffs[0]!.path, 'agent.md');
    } finally {
      await local.close();
    }
  });

  it('GET /:id/diff returns 400 on malformed side params', async () => {
    const local = await startHarness({});
    try {
      const res = await fetch(
        `${local.baseUrl}/api/v1/profiles/demo-bot/diff?base=garbage&target=live`,
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'profile_snapshot.invalid_diff_side');
    } finally {
      await local.close();
    }
  });

  // Reference unused error class so the import isn't tree-shaken away from
  // typecheck's perspective; kept available in case follow-up tests want
  // direct instanceof checks against the route's error mapper.
  void SnapshotValidationError;
});
