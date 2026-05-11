import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import express from 'express';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createProfilesRouter } from '../src/routes/profiles.js';

/**
 * Phase 2.3 Slice 3 — drift / health-score HTTP routes (OB-65).
 *
 * Pinned behaviours:
 *  - GET /health 503 when no driftSweepPool wired
 *  - GET /health returns aggregated latest score per profile, fraction
 *    surfaced as 0-100 integer
 *  - GET /:id/health returns history limited to the requested profile
 *  - Invalid profile id rejected with 400
 */

const emptyCatalog: PluginCatalog = {
  list: () => [],
  get: () => undefined,
  getMany: () => [],
} as unknown as PluginCatalog;

interface FakeRow {
  profile_id?: string;
  snapshot_id: string;
  drift_score?: string;
  diverged_assets?: unknown;
  computed_at?: Date;
  latest_score?: string;
  diverged_count?: number;
}

interface QueryCapture {
  sql: string;
  params: unknown[];
}

class FakePool {
  readonly calls: QueryCapture[] = [];
  /** Returned for the aggregated `GET /health` query. */
  aggregatedRows: FakeRow[] = [];
  /** Returned for the per-profile history query. */
  historyRowsByProfile: Map<string, FakeRow[]> = new Map();

  async query(text: string, params?: unknown[]): Promise<{ rows: FakeRow[] }> {
    const trimmed = text.trim();
    this.calls.push({ sql: trimmed, params: params ?? [] });
    if (trimmed.startsWith('WITH ranked')) {
      return { rows: this.aggregatedRows };
    }
    if (trimmed.startsWith('SELECT\n           phs.snapshot_id')) {
      const profileId = (params?.[0] as string) ?? '';
      return { rows: this.historyRowsByProfile.get(profileId) ?? [] };
    }
    throw new Error(`FakePool: unexpected SQL ${trimmed.slice(0, 60)}`);
  }
}

interface Harness {
  baseUrl: string;
  pool: FakePool;
  close: () => Promise<void>;
}

async function startHarness(opts: { withPool?: boolean }): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'health-routes-'));
  const registry = new InMemoryInstalledRegistry();
  const pool = new FakePool();

  const router = createProfilesRouter({
    catalog: emptyCatalog,
    registry,
    profilesDir: tmpDir,
    ...(opts.withPool !== false ? { driftSweepPool: pool as never } : {}),
  });

  const app = express();
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
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    pool,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('GET /api/v1/profiles/health', () => {
  it('returns 503 when drift pool is not configured', async () => {
    const h = await startHarness({ withPool: false });
    try {
      const res = await fetch(`${h.baseUrl}/api/v1/profiles/health`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'profile_health.unavailable');
    } finally {
      await h.close();
    }
  });

  it('aggregates latest score per profile and surfaces 0-100 integer', async () => {
    const h = await startHarness({});
    h.pool.aggregatedRows = [
      {
        profile_id: 'profile-a',
        snapshot_id: 'snap-a',
        latest_score: '0.9000',
        diverged_count: 2,
        computed_at: new Date('2026-05-08T10:00:00Z'),
      },
      {
        profile_id: 'profile-b',
        snapshot_id: 'snap-b',
        latest_score: '0.0500',
        diverged_count: 7,
        computed_at: new Date('2026-05-08T11:00:00Z'),
      },
    ];
    try {
      const res = await fetch(`${h.baseUrl}/api/v1/profiles/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        profiles: Array<{
          profile_id: string;
          latest_score: number;
          diverged_count: number;
          computed_at: string;
        }>;
      };
      assert.equal(body.profiles.length, 2);
      const a = body.profiles.find((p) => p.profile_id === 'profile-a');
      const b = body.profiles.find((p) => p.profile_id === 'profile-b');
      assert.equal(a?.latest_score, 90);
      assert.equal(b?.latest_score, 5);
      assert.equal(a?.diverged_count, 2);
      assert.equal(b?.diverged_count, 7);
      assert.equal(a?.computed_at, '2026-05-08T10:00:00.000Z');
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/profiles/:id/health', () => {
  it('returns 503 when drift pool is not configured', async () => {
    const h = await startHarness({ withPool: false });
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/profiles/demo-bot/health`,
      );
      assert.equal(res.status, 503);
    } finally {
      await h.close();
    }
  });

  it('rejects malformed profile ids with 400', async () => {
    const h = await startHarness({});
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/profiles/Bad_ID/health`,
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'profiles.invalid_id');
    } finally {
      await h.close();
    }
  });

  it('returns score history scoped to the requested profile', async () => {
    const h = await startHarness({});
    h.pool.historyRowsByProfile.set('profile-a', [
      {
        snapshot_id: 'snap-1',
        drift_score: '0.7000',
        computed_at: new Date('2026-05-08T03:00:00Z'),
        diverged_assets: {
          score: 70,
          divergedAssets: [
            { path: 'agent.md', status: 'modified', weight: 1.0 },
          ],
          suggestions: [
            { id: 'agent-md-modified', severity: 'critical', message: 'x' },
          ],
        },
      },
    ]);
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/profiles/profile-a/health`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        history: Array<{
          snapshot_id: string;
          score: number;
          diverged_assets: unknown[];
          suggestions: unknown[];
        }>;
      };
      assert.equal(body.history.length, 1);
      assert.equal(body.history[0]?.snapshot_id, 'snap-1');
      assert.equal(body.history[0]?.score, 70);
      assert.equal(body.history[0]?.diverged_assets.length, 1);
      assert.equal(body.history[0]?.suggestions.length, 1);

      // Confirm the SQL was parameterised by the requested profile id.
      const historyCall = h.pool.calls.find((c) =>
        c.sql.startsWith('SELECT\n           phs.snapshot_id'),
      );
      assert.ok(historyCall);
      assert.equal(historyCall!.params[0], 'profile-a');
    } finally {
      await h.close();
    }
  });

  it('renders the drift admin-ui at /health/admin-ui', async () => {
    const h = await startHarness({});
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/profiles/health/admin-ui`,
      );
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get('content-type') ?? '',
        /text\/html/,
      );
      const body = await res.text();
      // Sanity: the HTML must reference the JSON endpoint it polls
      // (regression catch if either side is renamed without the other).
      assert.ok(body.includes('/api/v1/profiles/health'));
      assert.ok(body.includes('Profile Drift'));
    } finally {
      await h.close();
    }
  });

  it('falls back to drift_score fraction when JSON payload missing score', async () => {
    const h = await startHarness({});
    h.pool.historyRowsByProfile.set('profile-x', [
      {
        snapshot_id: 'snap-x',
        drift_score: '0.5000',
        computed_at: new Date('2026-05-08T03:00:00Z'),
        diverged_assets: null,
      },
    ]);
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/profiles/profile-x/health`,
      );
      const body = (await res.json()) as {
        history: Array<{ score: number }>;
      };
      assert.equal(body.history[0]?.score, 50);
    } finally {
      await h.close();
    }
  });
});
