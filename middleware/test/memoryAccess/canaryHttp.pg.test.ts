/**
 * The topic leg of the per-person REST sweep (`canaryHttp.ts`) on Neon:
 * `/api/v1/admin/topics` and its detail route, called as every person of
 * both tenants over the seeded world. A topic is content of every member
 * (ADR 0045, #1851): a canary `expectedHttp` forbids on either route fails,
 * and each person must get the topics over their own memories (positive
 * control). The full sweep runs on the in-memory graph (`canaryHttp.test.ts`).
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one (issue #572). Runs in `npm run test:pg`.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { seedNeon, type NeonSeeded } from './backends.js';
import { sweepHttp, type HttpSighting } from './canaryHttp.js';
import { expectedHttp } from './oracle.js';
import { USER_KEYS, buildWorld } from './world.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/canaryHttp',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const NO_DUPLICATES = { memories: [], excerpts: [] } as const;
const TOPIC_ROUTES = ['GET /api/v1/admin/topics', 'GET /api/v1/admin/topics/:id'] as const;

describe('memory access — topic routes on NeonKnowledgeGraph (#1851, real PG)', () => {
  const world = buildWorld();
  let pool: Pool | undefined;
  let neon: NeonSeeded;
  const swept = new Map<string, HttpSighting[]>();

  before(async () => {
    if (!pgUp) return;
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    neon = await seedNeon(pool, world);
    for (const tenant of ['main', 'other'] as const) {
      for (const user of USER_KEYS) {
        const all = await sweepHttp(neon.seeded, tenant, user, NO_DUPLICATES);
        swept.set(`${tenant}/${user}`, all.filter((s) => s.route.includes('/admin/topics')));
      }
    }
  });

  after(async () => {
    if (!pool) return;
    await neon?.clean();
    await pool.end();
  });

  for (const tenant of ['main', 'other'] as const) {
    for (const user of USER_KEYS) {
      const who = `${tenant}/${user}`;

      it(`${who}: no topic built from memories the caller cannot read`, (t) => {
        if (!pool) return t.skip('no test database');
        const leaks = (swept.get(who) ?? []).filter((s) => !s.verdict.allowed);
        assert.deepEqual(
          leaks.map((s) => `${s.route}: ${s.canary} — ${s.verdict.source}`),
          [],
        );
      });

      it(`${who}: CONTROL — both topic routes return the caller's own topics`, (t) => {
        if (!pool) return t.skip('no test database');
        const own = world.byStore.topic
          .filter((i) => i.tenant === tenant && expectedHttp(user, tenant, i).allowed)
          .map((i) => i.canary)
          .sort();
        for (const route of TOPIC_ROUTES) {
          const seen = [
            ...new Set(
              (swept.get(who) ?? [])
                .filter((s) => s.route === route && s.item.store === 'topic')
                .map((s) => s.canary),
            ),
          ].sort();
          assert.deepEqual(seen, own, `${who} ${route}`);
        }
      });
    }
  }
});
