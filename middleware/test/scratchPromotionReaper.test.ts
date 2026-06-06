import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import {
  createScratchPromotionReaper,
  deriveAgentSlug,
} from '@omadia/orchestrator-extras/dist/scratchPromotionReaper.js';
import type {
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
} from '@omadia/plugin-api';

// Throwaway PG configured by the WS5 driver (docker container
// `mwtest-pg-ws5` on :55437). Fall back to MEMORY_PG_TEST_URL / the
// conventional throwaway URL so the file runs standalone too.
const PG_URL =
  process.env['WS5_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  'postgres://test:test@127.0.0.1:55437/test';

// --- migration DDL (copy of 0001_memory_files.sql) ------------------------
const MEMORY_FILES_DDL = `
CREATE TABLE IF NOT EXISTS memory_files (
  virtual_path TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_files_prefix
  ON memory_files (virtual_path text_pattern_ops);
`;

// A fake SignificanceScorer: high for content containing 'SIGNIFICANT',
// low otherwise. Deterministic.
function makeFakeScorer(): {
  score(text: string): Promise<{ score: number }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    async score(text: string): Promise<{ score: number }> {
      calls.push(text);
      return { score: text.includes('SIGNIFICANT') ? 0.95 : 0.1 };
    },
    calls,
  };
}

// Fake KG capturing createMemorableKnowledge calls.
function makeFakeKg(): {
  kg: KnowledgeGraph;
  createCalls: MemorableKnowledgeIngest[];
} {
  const createCalls: MemorableKnowledgeIngest[] = [];
  const kg = {
    async createMemorableKnowledge(
      input: MemorableKnowledgeIngest,
    ): Promise<MemorableKnowledgeIngestResult> {
      createCalls.push(input);
      return {
        memorableKnowledgeNodeId: `mk:scratch-${String(createCalls.length)}`,
        skippedInvolved: 0,
        skippedRequired: 0,
        skippedDerivedFrom: 0,
      };
    },
  } as unknown as KnowledgeGraph;
  return { kg, createCalls };
}

const SIGNIFICANT_BODY =
  'SIGNIFICANT: customer byte5 prefers invoices issued on the 1st of the month, ' +
  'net-14, EUR, and always wants a PDF copy mailed to accounting@byte5.de.';
const TRIVIAL_BODY = 'ok thanks bye';

const SIG_PATH = '/memories/orchestrators/a/note.md';
const TRIVIAL_PATH = '/memories/orchestrators/b/chitchat.md';
const FRESH_PATH = '/memories/orchestrators/c/fresh.md';

describe('WS5 · deriveAgentSlug', () => {
  it('extracts the orchestrator slug from a scratch path', () => {
    assert.equal(deriveAgentSlug('/memories/orchestrators/a/note.md'), 'a');
    assert.equal(
      deriveAgentSlug('/memories/orchestrators/odoo-hr/sub/deep.md'),
      'odoo-hr',
    );
    assert.equal(deriveAgentSlug('/memories/orchestrators/solo'), 'solo');
    assert.equal(deriveAgentSlug('/memories/other/x.md'), '');
  });
});

// --- Real-PG suite (preferred) -------------------------------------------
let pgUp = false;
const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
try {
  await probePool.query('SELECT 1');
  pgUp = true;
} catch {
  console.error(
    `[scratchPromotionReaper] PG at ${PG_URL} unreachable — running fake-pool flow only`,
  );
}

if (pgUp) {
  const pool = probePool;

  after(async () => {
    await pool.end();
  });

  describe('WS5 · ScratchPromotionReaper (real PG)', () => {
    it('promotes aged+significant scratch, leaves trivial + fresh', async () => {
      await pool.query('DROP TABLE IF EXISTS memory_files');
      await pool.query(MEMORY_FILES_DDL);

      // OLD significant (updated 2 days ago).
      await pool.query(
        `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')`,
        [SIG_PATH, SIGNIFICANT_BODY, SIGNIFICANT_BODY.length],
      );
      // OLD trivial (updated 2 days ago).
      await pool.query(
        `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')`,
        [TRIVIAL_PATH, TRIVIAL_BODY, TRIVIAL_BODY.length],
      );
      // FRESH significant (updated now → age-gated out).
      await pool.query(
        `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [FRESH_PATH, SIGNIFICANT_BODY, SIGNIFICANT_BODY.length],
      );

      const scorer = makeFakeScorer();
      const { kg, createCalls } = makeFakeKg();
      const reaper = createScratchPromotionReaper({
        pool,
        tenantId: 'default',
        kg,
        scorer,
        threshold: 0.6,
        ageMs: 24 * 3_600_000, // 24h
        intervalMs: 60_000,
        defaultVisibility: 'team',
        log: () => {},
      });

      const res = await reaper.runOnce();

      // Counts: only the 2 aged rows are scanned (fresh is age-gated by SQL).
      assert.equal(res.scanned, 2, 'fresh row age-gated out of scan');
      assert.equal(res.promoted, 1);
      assert.equal(res.skipped, 1); // old+trivial
      assert.equal(res.failed, 0);

      // The significant MK was created with the right shape.
      assert.equal(createCalls.length, 1);
      const mk = createCalls[0]!;
      assert.equal(mk.kind, 'insight');
      assert.equal(mk.originAgent, 'a');
      assert.equal(mk.createdBy, 'scratch-reaper');
      assert.deepEqual(mk.aclOwners, []);
      assert.deepEqual(mk.involvedOmadiaUserIds, []);
      assert.ok(mk.summary.includes('SIGNIFICANT'));

      // Significant scratch row deleted; trivial + fresh still present.
      const remaining = await pool.query<{ virtual_path: string }>(
        'SELECT virtual_path FROM memory_files ORDER BY virtual_path',
      );
      const paths = remaining.rows.map((r) => r.virtual_path);
      assert.deepEqual(paths, [TRIVIAL_PATH, FRESH_PATH]);
      assert.ok(!paths.includes(SIG_PATH), 'promoted row deleted');
    });

    it('failed promote leaves the scratch row intact', async () => {
      await pool.query('DROP TABLE IF EXISTS memory_files');
      await pool.query(MEMORY_FILES_DDL);
      await pool.query(
        `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')`,
        [SIG_PATH, SIGNIFICANT_BODY, SIGNIFICANT_BODY.length],
      );

      const scorer = makeFakeScorer();
      const throwingKg = {
        async createMemorableKnowledge(): Promise<never> {
          throw new Error('kg-down');
        },
      } as unknown as KnowledgeGraph;

      const reaper = createScratchPromotionReaper({
        pool,
        tenantId: 'default',
        kg: throwingKg,
        scorer,
        threshold: 0.6,
        ageMs: 24 * 3_600_000,
        intervalMs: 60_000,
        defaultVisibility: 'team',
        log: () => {},
      });

      const res = await reaper.runOnce();
      assert.equal(res.scanned, 1);
      assert.equal(res.promoted, 0);
      assert.equal(res.failed, 1);

      // Row must survive a failed promote (delete-after-create invariant).
      const cnt = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM memory_files WHERE virtual_path = $1',
        [SIG_PATH],
      );
      assert.equal(cnt.rows[0]!.count, '1');
    });
  });
}

// --- Table-absent no-op (always runs; fake pool) --------------------------
describe('WS5 · ScratchPromotionReaper (table absent)', () => {
  it('no-ops without throwing when memory_files does not exist', async () => {
    const undefinedTableErr = Object.assign(new Error('relation "memory_files" does not exist'), {
      code: '42P01',
    });
    const fakePool = {
      async query(): Promise<never> {
        throw undefinedTableErr;
      },
    } as unknown as Pool;

    const scorer = makeFakeScorer();
    const { kg, createCalls } = makeFakeKg();
    const reaper = createScratchPromotionReaper({
      pool: fakePool,
      tenantId: 'default',
      kg,
      scorer,
      threshold: 0.6,
      ageMs: 24 * 3_600_000,
      intervalMs: 60_000,
      defaultVisibility: 'team',
      log: () => {},
    });

    const res = await reaper.runOnce();
    assert.deepEqual(res, { scanned: 0, promoted: 0, skipped: 0, failed: 0 });
    assert.equal(createCalls.length, 0);
    assert.equal(scorer.calls.length, 0);
  });
});
