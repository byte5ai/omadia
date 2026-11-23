import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import {
  createScratchPromotionReaper,
  deriveAgentSlug,
} from '@omadia/orchestrator-extras/dist/scratchPromotionReaper.js';

import { makeFakeKg, makeFakeScorer } from './_helpers/scratchPromotionFakes.js';

// Database-free cases of the scratch-promotion reaper. The real-Postgres
// suites are in `scratchPromotionReaper.pg.test.ts` (`npm run test:pg`).

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
    assert.deepEqual(res, {
      scanned: 0,
      promoted: 0,
      skipped: 0,
      dropped: 0,
      failed: 0,
    });
    assert.equal(createCalls.length, 0);
    assert.equal(scorer.calls.length, 0);
  });
});
