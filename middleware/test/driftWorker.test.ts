import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runDriftSweep } from '../src/profileSnapshots/driftWorker.js';
import type { AssetDiff, SnapshotService } from '../src/profileSnapshots/snapshotService.js';

/**
 * Phase 2.3 Slice 2 — driftWorker coverage.
 *
 * The worker is a thin coordinator: it loads deploy-ready baselines,
 * fans out per-profile diffs, computes scores, and persists rows. The
 * tests here pin down the contract:
 *  - happy path: 2 baselines → 2 health-score rows inserted
 *  - no baselines: zero queries past the SELECT, no error
 *  - one profile errors → others still complete (Promise.allSettled)
 *
 * No live PG. Fake-pool returns canned shapes; fake-service returns canned diffs.
 */

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface BaselineRow {
  profile_id: string;
  snapshot_id: string;
}

class FakePool {
  readonly calls: QueryCall[] = [];
  baselines: BaselineRow[] = [];
  /** Inserts captured here; tests assert the shape. */
  inserts: Array<{ snapshotId: string; fraction: string; payload: string }> =
    [];
  /** Throw when the INSERT for this snapshot_id is attempted. */
  failInsertForSnapshot: string | null = null;

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const trimmed = text.trim();
    this.calls.push({ sql: trimmed, params: params ?? [] });

    if (trimmed.startsWith('SELECT DISTINCT ON (profile_id)')) {
      return { rows: this.baselines };
    }
    if (trimmed.startsWith('INSERT INTO profile_health_score')) {
      const [snapshotId, fraction, payload] = (params ?? []) as string[];
      assert.ok(snapshotId, 'snapshot id required');
      assert.ok(fraction, 'fraction required');
      assert.ok(payload, 'payload required');
      if (this.failInsertForSnapshot === snapshotId) {
        throw new Error(`simulated DB failure for ${snapshotId}`);
      }
      this.inserts.push({ snapshotId, fraction, payload });
      return { rows: [] };
    }
    throw new Error(`FakePool (drift): unsupported SQL: ${trimmed.slice(0, 100)}`);
  }
}

interface FakeServiceConfig {
  diffsBySnapshot: Record<string, AssetDiff[]>;
  failProfileId?: string;
}

function makeFakeSnapshotService(cfg: FakeServiceConfig): SnapshotService {
  return {
    async diff(input: { base: { kind: 'snapshot'; snapshotId: string }; target: { kind: 'live'; profileId: string } }) {
      if (input.target.kind === 'live' && input.target.profileId === cfg.failProfileId) {
        throw new Error(`simulated diff failure for ${cfg.failProfileId}`);
      }
      return cfg.diffsBySnapshot[input.base.snapshotId] ?? [];
    },
  } as unknown as SnapshotService;
}

describe('runDriftSweep', () => {
  it('runs zero work when no profile has a deploy-ready snapshot', async () => {
    const pool = new FakePool();
    const service = makeFakeSnapshotService({ diffsBySnapshot: {} });
    const result = await runDriftSweep({
      pool: pool as never,
      snapshotService: service,
      log: () => {},
    });
    assert.equal(result.profiles.length, 0);
    // Only the SELECT was run.
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.inserts.length, 0);
  });

  it('writes one health_score row per baseline (happy path)', async () => {
    const pool = new FakePool();
    pool.baselines = [
      { profile_id: 'profile-a', snapshot_id: 'snap-a' },
      { profile_id: 'profile-b', snapshot_id: 'snap-b' },
    ];
    const service = makeFakeSnapshotService({
      diffsBySnapshot: {
        'snap-a': [], // perfect — score 100, fraction 1.0000
        'snap-b': [
          {
            path: 'agent.md',
            status: 'modified',
            baseSha256: 'aaa',
            targetSha256: 'bbb',
          },
        ],
      },
    });
    const result = await runDriftSweep({
      pool: pool as never,
      snapshotService: service,
      log: () => {},
    });

    assert.equal(result.profiles.length, 2);
    assert.equal(pool.inserts.length, 2);

    const a = pool.inserts.find((i) => i.snapshotId === 'snap-a');
    const b = pool.inserts.find((i) => i.snapshotId === 'snap-b');
    assert.ok(a, 'expected insert for snap-a');
    assert.ok(b, 'expected insert for snap-b');
    assert.equal(a!.fraction, '1.0000');
    assert.equal(b!.fraction, '0.0000');

    const aPayload = JSON.parse(a!.payload) as { score: number; divergedAssets: unknown[] };
    assert.equal(aPayload.score, 100);
    assert.equal(aPayload.divergedAssets.length, 0);

    const bPayload = JSON.parse(b!.payload) as { score: number; divergedAssets: Array<{ status: string }> };
    assert.equal(bPayload.score, 0);
    assert.equal(bPayload.divergedAssets.length, 1);
    assert.equal(bPayload.divergedAssets[0]?.status, 'modified');
  });

  it('isolates per-profile failures so other profiles still complete', async () => {
    const pool = new FakePool();
    pool.baselines = [
      { profile_id: 'good-1', snapshot_id: 'snap-good-1' },
      { profile_id: 'bad', snapshot_id: 'snap-bad' },
      { profile_id: 'good-2', snapshot_id: 'snap-good-2' },
    ];
    const service = makeFakeSnapshotService({
      diffsBySnapshot: {
        'snap-good-1': [],
        'snap-good-2': [],
      },
      failProfileId: 'bad',
    });

    const result = await runDriftSweep({
      pool: pool as never,
      snapshotService: service,
      log: () => {},
    });

    assert.equal(result.profiles.length, 3);
    const byId = new Map(result.profiles.map((p) => [p.profileId, p]));
    assert.equal(byId.get('good-1')?.status, 'ok');
    assert.equal(byId.get('good-2')?.status, 'ok');
    assert.equal(byId.get('bad')?.status, 'error');
    assert.match(byId.get('bad')?.error ?? '', /simulated diff failure/);

    // Both good profiles persisted; the bad one did NOT.
    assert.equal(pool.inserts.length, 2);
    const insertedSnapshots = new Set(pool.inserts.map((i) => i.snapshotId));
    assert.ok(insertedSnapshots.has('snap-good-1'));
    assert.ok(insertedSnapshots.has('snap-good-2'));
    assert.ok(!insertedSnapshots.has('snap-bad'));
  });

  it('records a DB-insert failure as per-profile error without aborting others', async () => {
    const pool = new FakePool();
    pool.baselines = [
      { profile_id: 'a', snapshot_id: 'snap-a' },
      { profile_id: 'b', snapshot_id: 'snap-b' },
    ];
    pool.failInsertForSnapshot = 'snap-a';
    const service = makeFakeSnapshotService({
      diffsBySnapshot: { 'snap-a': [], 'snap-b': [] },
    });

    const result = await runDriftSweep({
      pool: pool as never,
      snapshotService: service,
      log: () => {},
    });

    const byId = new Map(result.profiles.map((p) => [p.profileId, p]));
    assert.equal(byId.get('a')?.status, 'error');
    assert.equal(byId.get('b')?.status, 'ok');
    assert.equal(pool.inserts.length, 1);
    assert.equal(pool.inserts[0]?.snapshotId, 'snap-b');
  });
});
