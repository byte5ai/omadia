import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  UploadedPackageStore,
  type UploadedPackage,
} from '../src/plugins/uploadedPackageStore.js';
import {
  SnapshotService,
  SnapshotValidationError,
} from '../src/profileSnapshots/snapshotService.js';
import type { LiveProfileState } from '../src/profileStorage/liveProfileStorageService.js';

/**
 * Phase 2.2-B coverage — SnapshotService create + read paths.
 *
 * The real `zipProfileBundle` runs in these tests (no zipper stub) so
 * roundtrips catch any drift between the zipper and the snapshot
 * extractor. The DB layer is a `FakePool` with the exact SQL shape the
 * service emits — schema-drift between service and migration would be
 * caught here without needing a live Postgres in CI.
 *
 * Phase 2.2-C (mark-deploy-ready, rollback, diff), 2.2-D (HTTP routes)
 * and 2.2-E (admin UI) come later.
 */

// ─────────────────────────────────────────────────────────────────────────
// FakePool — simulates the four SQL shapes the service emits.
// ─────────────────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  profile_id: string;
  profile_version: string;
  bundle_hash: string;
  manifest_yaml: string;
  bundle_size_bytes: number;
  created_at: Date;
  created_by: string;
  notes: string | null;
  is_deploy_ready: boolean;
  deploy_ready_at: Date | null;
  deploy_ready_by: string | null;
}

interface AssetRow {
  snapshot_id: string;
  path: string;
  content: Buffer;
  sha256: string;
  size_bytes: number;
}

interface HealthRow {
  snapshot_id: string;
  computed_at: Date;
  drift_score: number;
}

class FakePool {
  snapshots: SnapshotRow[] = [];
  assets: AssetRow[] = [];
  health: HealthRow[] = [];
  private uuidCounter = 0;

  // Stand-in for `pool.connect()` — same client surface (query + release).
  // Transactions are simulated as no-ops; the test cares about end-state.
  async connect() {
    return {
      query: async (sql: string, params: unknown[] = []) =>
        this.dispatch(sql, params),
      release: () => {
        /* noop */
      },
    };
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params);
  }

  private dispatch(sql: string, params: unknown[]) {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (trimmed.startsWith('INSERT INTO profile_snapshot ') && trimmed.includes('ON CONFLICT')) {
      const [profileId, profileVersion, bundleHash, manifestYaml, bundleSizeBytes, createdBy, notes] =
        params as [string, string, string, string, number, string, string | null];
      const existing = this.snapshots.find(
        (s) => s.profile_id === profileId && s.bundle_hash === bundleHash,
      );
      if (existing) return { rows: [], rowCount: 0 };
      const id = `00000000-0000-4000-8000-${String(++this.uuidCounter).padStart(12, '0')}`;
      const row: SnapshotRow = {
        id,
        profile_id: profileId,
        profile_version: profileVersion,
        bundle_hash: bundleHash,
        manifest_yaml: manifestYaml,
        bundle_size_bytes: bundleSizeBytes,
        created_at: new Date(),
        created_by: createdBy,
        notes,
        is_deploy_ready: false,
        deploy_ready_at: null,
        deploy_ready_by: null,
      };
      this.snapshots.push(row);
      return {
        rows: [{ id: row.id, created_at: row.created_at }],
        rowCount: 1,
      };
    }

    if (trimmed.startsWith('SELECT id, created_at FROM profile_snapshot WHERE profile_id =')) {
      const [profileId, bundleHash] = params as [string, string];
      const found = this.snapshots.find(
        (s) => s.profile_id === profileId && s.bundle_hash === bundleHash,
      );
      return {
        rows: found ? [{ id: found.id, created_at: found.created_at }] : [],
        rowCount: found ? 1 : 0,
      };
    }

    if (trimmed.startsWith('INSERT INTO profile_snapshot_asset')) {
      const [snapshotId, p, content, sha256, sizeBytes] = params as [
        string,
        string,
        Buffer,
        string,
        number,
      ];
      this.assets.push({ snapshot_id: snapshotId, path: p, content, sha256, size_bytes: sizeBytes });
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('INSERT INTO profile_health_score')) {
      const [snapshotId] = params as [string];
      this.health.push({ snapshot_id: snapshotId, computed_at: new Date(), drift_score: 0 });
      return { rows: [], rowCount: 1 };
    }

    if (
      trimmed.startsWith('SELECT id, profile_id, profile_version, bundle_hash, bundle_size_bytes, created_at, created_by, notes, is_deploy_ready, deploy_ready_at, deploy_ready_by FROM profile_snapshot WHERE profile_id =')
    ) {
      const [profileId] = params as [string];
      const rows = this.snapshots
        .filter((s) => s.profile_id === profileId)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((s) => ({ ...s }));
      return { rows, rowCount: rows.length };
    }

    if (trimmed.startsWith('SELECT id, profile_id, profile_version, bundle_hash, bundle_size_bytes, created_at, created_by, notes, is_deploy_ready, deploy_ready_at, deploy_ready_by, manifest_yaml FROM profile_snapshot WHERE id =')) {
      const [snapshotId] = params as [string];
      const found = this.snapshots.find((s) => s.id === snapshotId);
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    if (trimmed.startsWith('SELECT path, sha256, size_bytes FROM profile_snapshot_asset WHERE snapshot_id =')) {
      const [snapshotId] = params as [string];
      const rows = this.assets
        .filter((a) => a.snapshot_id === snapshotId)
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((a) => ({ path: a.path, sha256: a.sha256, size_bytes: a.size_bytes }));
      return { rows, rowCount: rows.length };
    }

    if (trimmed.startsWith('SELECT drift_score FROM profile_health_score WHERE snapshot_id =')) {
      const [snapshotId] = params as [string];
      const row = this.health
        .filter((h) => h.snapshot_id === snapshotId)
        .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime())[0];
      return { rows: row ? [{ drift_score: String(row.drift_score) }] : [], rowCount: row ? 1 : 0 };
    }

    if (trimmed.startsWith('SELECT content FROM profile_snapshot_asset WHERE snapshot_id =')) {
      const [snapshotId, p] = params as [string, string];
      const row = this.assets.find((a) => a.snapshot_id === snapshotId && a.path === p);
      return { rows: row ? [{ content: row.content }] : [], rowCount: row ? 1 : 0 };
    }

    if (trimmed.startsWith('UPDATE profile_snapshot SET is_deploy_ready = true')) {
      const [snapshotId, operator] = params as [string, string];
      const row = this.snapshots.find((s) => s.id === snapshotId);
      if (!row) return { rows: [], rowCount: 0 };
      row.is_deploy_ready = true;
      row.deploy_ready_at = new Date();
      row.deploy_ready_by = operator;
      return { rows: [{ ...row }], rowCount: 1 };
    }

    throw new Error(`FakePool (snapshot): unsupported SQL in test: ${trimmed.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

const TEST_PLUGIN_ID = 'harness-plugin-test-fixture';
const TEST_PLUGIN_VERSION = '1.0.0';
const TEST_PLUGIN_SHA = 'a'.repeat(64);

function makeUploadedPackage(overrides: Partial<UploadedPackage> = {}): UploadedPackage {
  return {
    id: TEST_PLUGIN_ID,
    version: TEST_PLUGIN_VERSION,
    path: '/tmp/fake-plugin-path',
    uploaded_at: '2026-05-07T10:00:00.000Z',
    uploaded_by: 'test@example.com',
    sha256: TEST_PLUGIN_SHA,
    peers_missing: [],
    zip_bytes: 0,
    extracted_bytes: 0,
    file_count: 0,
    ...overrides,
  };
}

const FIXTURE_AGENT_MD = `---
schema_version: 1
identity:
  id: demo-bot
  display_name: Demo Bot
---

# System Prompt

Antworte knapp.
`;

function makeLiveState(overrides: Partial<LiveProfileState> = {}): LiveProfileState {
  return {
    profileId: 'demo-bot',
    profileName: 'Demo Bot',
    profileVersion: '1.0.0',
    agentMd: Buffer.from(FIXTURE_AGENT_MD, 'utf8'),
    pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
    knowledge: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('SnapshotService · validation', () => {
  it('rejects invalid profile id', async () => {
    const pool = new FakePool();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-val-'));
    const store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    await assert.rejects(
      () => service.createSnapshot({ profileId: 'INVALID ID', createdBy: 'op@x' }),
      SnapshotValidationError,
    );
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects empty actor', async () => {
    const pool = new FakePool();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-val-'));
    const store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    await assert.rejects(
      () => service.createSnapshot({ profileId: 'demo-bot', createdBy: '' }),
      SnapshotValidationError,
    );
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects malformed snapshot id on read', async () => {
    const pool = new FakePool();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-val-'));
    const store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    await assert.rejects(
      () => service.getSnapshot('not-a-uuid'),
      SnapshotValidationError,
    );
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});

describe('SnapshotService · create roundtrip', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let pool: FakePool;
  let service: SnapshotService;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
    store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    await store.register(makeUploadedPackage());
    pool = new FakePool();
    service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('captures live state and persists snapshot + assets + initial health', async () => {
    const result = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
      notes: 'first capture',
    });

    assert.equal(result.wasExisting, false);
    assert.match(result.snapshotId, /^[0-9a-f-]{36}$/);
    assert.equal(result.bundleHash.length, 64);
    assert.ok(result.bundleSizeBytes > 0);

    // 1 snapshot row
    assert.equal(pool.snapshots.length, 1);
    assert.equal(pool.snapshots[0]!.profile_id, 'demo-bot');
    assert.equal(pool.snapshots[0]!.notes, 'first capture');

    // assets contain at least manifest + agent.md + plugins.lock
    const paths = pool.assets.map((a) => a.path).sort();
    assert.ok(paths.includes('profile-manifest.yaml'));
    assert.ok(paths.includes('agent.md'));
    assert.ok(paths.includes('plugins.lock'));

    // initial health row
    assert.equal(pool.health.length, 1);
    assert.equal(pool.health[0]!.drift_score, 0);
  });

  it('is idempotent — second create with identical state returns existing snapshot', async () => {
    const first = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    const second = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });

    assert.equal(first.wasExisting, false);
    assert.equal(second.wasExisting, true);
    assert.equal(second.snapshotId, first.snapshotId);
    assert.equal(second.bundleHash, first.bundleHash);

    // Only one row in DB despite two calls
    assert.equal(pool.snapshots.length, 1);
    // Initial health row only inserted once
    assert.equal(pool.health.length, 1);
  });

  it('persists knowledge files as snapshot assets', async () => {
    const knowledgeContent = Buffer.from('# Style\nKurz.', 'utf8');
    const customService = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () =>
        makeLiveState({
          knowledge: [{ filename: 'style.md', content: knowledgeContent }],
        }),
    });

    await customService.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });

    const knowledgeAsset = pool.assets.find((a) => a.path === 'knowledge/style.md');
    assert.ok(knowledgeAsset, 'knowledge asset captured');
    assert.equal(knowledgeAsset!.content.toString('utf8'), '# Style\nKurz.');
  });
});

describe('SnapshotService · read paths', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let pool: FakePool;
  let service: SnapshotService;
  let snapshotId: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
    store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    await store.register(makeUploadedPackage());
    pool = new FakePool();
    service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    snapshotId = created.snapshotId;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('listSnapshots returns the snapshot with full metadata', async () => {
    const list = await service.listSnapshots('demo-bot');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.snapshotId, snapshotId);
    assert.equal(list[0]!.profileId, 'demo-bot');
    assert.equal(list[0]!.profileVersion, '1.0.0');
    assert.equal(list[0]!.isDeployReady, false);
  });

  it('listSnapshots scopes by profile', async () => {
    const empty = await service.listSnapshots('other-bot');
    assert.equal(empty.length, 0);
  });

  it('getSnapshot returns asset summaries + drift score', async () => {
    const detail = await service.getSnapshot(snapshotId);
    assert.ok(detail);
    assert.equal(detail!.snapshotId, snapshotId);
    assert.ok(detail!.assets.length >= 3);
    assert.ok(detail!.assets.some((a) => a.path === 'agent.md'));
    assert.equal(detail!.driftScore, 0);
    assert.ok(detail!.manifestYaml.includes('bundle_hash'));
  });

  it('getSnapshot returns null for unknown id', async () => {
    const detail = await service.getSnapshot('00000000-0000-4000-8000-aaaaaaaaaaaa');
    assert.equal(detail, null);
  });

  it('getAssetBytes returns exact bytes for known asset', async () => {
    const bytes = await service.getAssetBytes(snapshotId, 'agent.md');
    assert.ok(bytes);
    assert.equal(bytes!.toString('utf8'), FIXTURE_AGENT_MD);
  });

  it('getAssetBytes returns null for unknown path', async () => {
    const bytes = await service.getAssetBytes(snapshotId, 'does-not-exist.md');
    assert.equal(bytes, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 2.2-C — mark-deploy-ready + rollback + diff
// ─────────────────────────────────────────────────────────────────────────

describe('SnapshotService · mark-deploy-ready', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let pool: FakePool;
  let service: SnapshotService;
  let snapshotId: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-mdr-'));
    store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    await store.register(makeUploadedPackage());
    pool = new FakePool();
    service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    snapshotId = created.snapshotId;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('marks an unmarked snapshot deploy-ready and stamps audit fields', async () => {
    const result = await service.markDeployReady({
      snapshotId,
      operator: 'op@example.com',
    });
    assert.equal(result.isDeployReady, true);
    assert.equal(result.deployReadyBy, 'op@example.com');
    assert.ok(result.deployReadyAt instanceof Date);
  });

  it('is idempotent — second mark refreshes only the audit fields', async () => {
    const first = await service.markDeployReady({ snapshotId, operator: 'op-a@example.com' });
    // Tiny wait so the second timestamp is strictly later than the first.
    await new Promise((r) => setTimeout(r, 5));
    const second = await service.markDeployReady({ snapshotId, operator: 'op-b@example.com' });
    assert.equal(second.isDeployReady, true);
    assert.equal(second.deployReadyBy, 'op-b@example.com');
    assert.ok(
      second.deployReadyAt!.getTime() >= first.deployReadyAt!.getTime(),
      'second mark must not roll back the audit timestamp',
    );
  });

  it('throws SnapshotNotFoundError on unknown snapshot id', async () => {
    await assert.rejects(
      () =>
        service.markDeployReady({
          snapshotId: '00000000-0000-4000-8000-999999999999',
          operator: 'op@example.com',
        }),
      (err) =>
        err instanceof Error &&
        (err as { code?: string }).code === 'snapshot.not_found',
    );
  });

  it('rejects malformed snapshot id', async () => {
    await assert.rejects(
      () => service.markDeployReady({ snapshotId: 'not-a-uuid', operator: 'op@example.com' }),
      SnapshotValidationError,
    );
  });
});

describe('SnapshotService · rollback', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let pool: FakePool;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-rb-'));
    store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    await store.register(makeUploadedPackage());
    pool = new FakePool();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reconstructs agent.md + knowledge from snapshot bytes and calls onPersist', async () => {
    let liveState: LiveProfileState = makeLiveState({
      knowledge: [{ filename: 'style.md', content: Buffer.from('original style', 'utf8') }],
    });
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => liveState,
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });

    // Mutate the live state — agent.md + knowledge content drift.
    liveState = makeLiveState({
      agentMd: Buffer.from('# Drifted body\n', 'utf8'),
      knowledge: [{ filename: 'style.md', content: Buffer.from('drifted style', 'utf8') }],
    });

    const captured: Array<{
      manifestProfileId: string;
      agentMd: Buffer;
      knowledge: Array<{ filename: string; content: Buffer }>;
      pluginCount: number;
    }> = [];
    const result = await service.rollback({
      snapshotId: created.snapshotId,
      operator: 'op@example.com',
      onPersist: async (payload) => {
        captured.push({
          manifestProfileId: payload.manifest.profile.id,
          agentMd: payload.agentMd,
          knowledge: payload.knowledge,
          pluginCount: payload.plugins.length,
        });
      },
    });

    assert.equal(captured.length, 1);
    const persisted = captured[0]!;
    assert.equal(persisted.manifestProfileId, 'demo-bot');
    assert.equal(persisted.agentMd.toString('utf8'), FIXTURE_AGENT_MD);
    assert.equal(persisted.knowledge.length, 1);
    assert.equal(persisted.knowledge[0]!.filename, 'knowledge/style.md');
    assert.equal(
      persisted.knowledge[0]!.content.toString('utf8'),
      'original style',
    );
    assert.equal(persisted.pluginCount, 1);
    assert.equal(result.rolledBackTo.snapshotId, created.snapshotId);
    assert.equal(result.rolledBackTo.bundleHash, created.bundleHash);
    assert.ok(
      result.divergedAssets.includes('agent.md'),
      `divergedAssets should mention agent.md, got ${JSON.stringify(result.divergedAssets)}`,
    );
    assert.ok(
      result.divergedAssets.includes('knowledge/style.md'),
      `divergedAssets should mention knowledge/style.md, got ${JSON.stringify(result.divergedAssets)}`,
    );
  });

  it('throws SnapshotNotFoundError on unknown snapshot id', async () => {
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    await assert.rejects(
      () =>
        service.rollback({
          snapshotId: '00000000-0000-4000-8000-999999999999',
          operator: 'op@example.com',
          onPersist: async () => {},
        }),
      (err) =>
        err instanceof Error &&
        (err as { code?: string }).code === 'snapshot.not_found',
    );
  });

  it('propagates onPersist failures so live state stays unchanged on caller side', async () => {
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    await assert.rejects(
      () =>
        service.rollback({
          snapshotId: created.snapshotId,
          operator: 'op@example.com',
          onPersist: async () => {
            throw new Error('storage write blew up');
          },
        }),
      /storage write blew up/,
    );
  });
});

describe('SnapshotService · diff', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;
  let pool: FakePool;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-diff-'));
    store = new UploadedPackageStore(
      path.join(tmpRoot, 'idx.json'),
      path.join(tmpRoot, 'pkgs'),
    );
    await store.load();
    await store.register(makeUploadedPackage());
    pool = new FakePool();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports all paths identical when comparing a snapshot to itself', async () => {
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState({
        knowledge: [{ filename: 'style.md', content: Buffer.from('s', 'utf8') }],
      }),
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    const diffs = await service.diff({
      base: { kind: 'snapshot', snapshotId: created.snapshotId },
      target: { kind: 'snapshot', snapshotId: created.snapshotId },
    });
    assert.ok(diffs.length >= 1);
    for (const d of diffs) {
      assert.equal(d.status, 'identical', `path ${d.path} should be identical`);
    }
  });

  it('detects modified agent.md between snapshot and drifted live state', async () => {
    let liveState: LiveProfileState = makeLiveState();
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => liveState,
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });

    liveState = makeLiveState({
      agentMd: Buffer.from('# Drifted body\n', 'utf8'),
    });

    const diffs = await service.diff({
      base: { kind: 'snapshot', snapshotId: created.snapshotId },
      target: { kind: 'live', profileId: 'demo-bot' },
    });
    const agentDiff = diffs.find((d) => d.path === 'agent.md');
    assert.ok(agentDiff, 'agent.md must appear in diffs');
    assert.equal(agentDiff!.status, 'modified');
    assert.ok(agentDiff!.baseSha256);
    assert.ok(agentDiff!.targetSha256);
    assert.notEqual(agentDiff!.baseSha256, agentDiff!.targetSha256);
  });

  it('detects added + removed knowledge files between sides', async () => {
    let liveState: LiveProfileState = makeLiveState({
      knowledge: [{ filename: 'old.md', content: Buffer.from('old', 'utf8') }],
    });
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => liveState,
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });

    // Drift: replace `old.md` with a new file `new.md`.
    liveState = makeLiveState({
      knowledge: [{ filename: 'new.md', content: Buffer.from('new', 'utf8') }],
    });

    const diffs = await service.diff({
      base: { kind: 'snapshot', snapshotId: created.snapshotId },
      target: { kind: 'live', profileId: 'demo-bot' },
    });
    const oldDiff = diffs.find((d) => d.path === 'knowledge/old.md');
    const newDiff = diffs.find((d) => d.path === 'knowledge/new.md');
    assert.ok(oldDiff, 'knowledge/old.md must appear');
    assert.equal(oldDiff!.status, 'removed');
    assert.ok(newDiff, 'knowledge/new.md must appear');
    assert.equal(newDiff!.status, 'added');
  });

  it('excludes auto-generated files (profile-manifest.yaml, plugins.lock) from diff', async () => {
    const service = new SnapshotService({
      pool: pool as never,
      zipperDeps: { store },
      profileLoader: async () => makeLiveState(),
    });
    const created = await service.createSnapshot({
      profileId: 'demo-bot',
      createdBy: 'op@example.com',
    });
    const diffs = await service.diff({
      base: { kind: 'snapshot', snapshotId: created.snapshotId },
      target: { kind: 'live', profileId: 'demo-bot' },
    });
    for (const d of diffs) {
      assert.notEqual(d.path, 'profile-manifest.yaml');
      assert.notEqual(d.path, 'plugins.lock');
    }
  });
});
