/**
 * Memory-ACL plan step 3 — canary sweep over the per-person REST routes
 * (`canaryHttp.ts`). A canary `expectedHttp` forbids in any response body is
 * a leak. Positive control: every route that returns content delivers the
 * caller's own canaries. (`/:id/audit` returns owner lists, not content.)
 *
 * Topics and duplicates live under `/api/v1/admin/*` but filter per viewer,
 * so they are swept like the personal routes. The other admin, operator and
 * dev routes take no viewer: every account is an administrator today
 * (`adminUsers.ts`), so they are operator-only by design. Purge preview
 * returns counts only; promote copies between an agent's tiers.
 *
 * Fixed and asserted: #1762 (a web chat tab belongs to the account that
 * created it; ADR 0180), #1851 (a topic's name and description are content of
 * every member, so a topic reaches only who reads all of them; ADR 0045).
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { seedInMemory } from './backends.js';
import { seedDuplicates, sweepHttp, type HttpRoute, type HttpSighting } from './canaryHttp.js';
import type { Seeded } from './seed.js';
import { USER_KEYS, buildWorld, type TenantKey, type UserKey } from './world.js';

interface KnownLeak {
  readonly issue: string;
  readonly title: string;
  readonly matches: (s: HttpSighting) => boolean;
}

const KNOWN_LEAKS: readonly KnownLeak[] = [];

const TOPIC_ROUTE = (s: HttpSighting): boolean => s.route.startsWith('GET /api/v1/admin/topics');

const CONTENT_ROUTES: readonly HttpRoute[] = [
  'GET /api/chat/sessions',
  'GET /api/chat/sessions/:id',
  'GET /api/v1/datasets',
  'GET /api/v1/datasets/:id',
  'GET /api/v1/datasets/:id/rows',
  'GET /api/v1/memory',
  'GET /api/v1/memory/:id',
  'GET /api/v1/memory/:id/excerpts',
  'GET /api/v1/admin/topics',
  'GET /api/v1/admin/topics/:id',
  'GET /api/v1/admin/duplicates',
  'GET /api/v1/admin/duplicates/:id',
  'GET /api/v1/admin/duplicates/excerpts',
  'GET /api/v1/admin/duplicates/excerpts/:id',
];

function report(who: string, leaks: readonly HttpSighting[]): string {
  return `${who}: ${String(leaks.length)} forbidden canaries:\n${leaks
    .slice(0, 40)
    .map((s) => `${s.route}: ${s.canary} (${s.item.store}) — ${s.verdict.source}`)
    .join('\n')}`;
}

describe('memory access — canary sweep over the per-person REST routes', () => {
  let seeded: Seeded;
  const swept = new Map<string, HttpSighting[]>();

  before(async () => {
    seeded = await seedInMemory(buildWorld());
    const duplicates = await seedDuplicates(seeded);
    for (const tenant of ['main', 'other'] as const) {
      for (const user of USER_KEYS) {
        swept.set(`${tenant}/${user}`, await sweepHttp(seeded, tenant, user, duplicates));
      }
    }
  });

  for (const tenant of ['main', 'other'] as const satisfies readonly TenantKey[]) {
    for (const user of USER_KEYS satisfies readonly UserKey[]) {
      const who = `${tenant}/${user}`;
      const sightings = (): HttpSighting[] => swept.get(who) ?? [];

      it(`${who}: no forbidden canary in any response, apart from the known leaks`, () => {
        const leaks = sightings().filter((s) => !s.verdict.allowed && !KNOWN_LEAKS.some((k) => k.matches(s)));
        assert.deepEqual(leaks, [], report(who, leaks));
      });

      it(`${who}: CONTROL — every content route returns the caller's own canaries`, () => {
        const routes = new Set(sightings().filter((s) => s.verdict.allowed).map((s) => s.route));
        assert.deepEqual([...routes].sort(), [...CONTENT_ROUTES].sort());
      });

      it(`${who}: #1851: topics show no content of memories the caller cannot read`, () => {
        const leaks = sightings().filter((s) => !s.verdict.allowed && TOPIC_ROUTE(s));
        assert.deepEqual(leaks, [], report(who, leaks));
      });

      for (const k of KNOWN_LEAKS) {
        it(`${who}: known leak ${k.issue}: ${k.title}`, { todo: k.issue }, () => {
          const leaks = sightings().filter((s) => !s.verdict.allowed && k.matches(s));
          assert.deepEqual(leaks, [], report(who, leaks));
        });
      }
    }
  }
});
