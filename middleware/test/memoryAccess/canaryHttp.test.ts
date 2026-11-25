/**
 * Memory-ACL plan step 3 — canary sweep over the per-person REST routes
 * (`canaryHttp.ts`). A canary `expectedHttp` forbids in any response body is
 * a leak. Positive control: every route that returns content delivers the
 * caller's own canaries. (`/:id/audit` returns owner lists, not content.)
 *
 * The admin, operator and dev routes are not here: every account is an
 * administrator today (`adminUsers.ts`), so they are operator-only by design.
 *
 * Known leak, kept as `todo` until its fix: #1762 (chat sessions have no
 * owner; every account lists and reads every web chat tab).
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { seedInMemory } from './backends.js';
import { sweepHttp, type HttpRoute, type HttpSighting } from './canaryHttp.js';
import type { Seeded } from './seed.js';
import { USER_KEYS, buildWorld, type TenantKey, type UserKey } from './world.js';

const CHAT_SESSIONS_HAVE_NO_OWNER = (s: HttpSighting): boolean => s.route.startsWith('GET /api/chat/');

const CONTENT_ROUTES: readonly HttpRoute[] = [
  'GET /api/chat/sessions',
  'GET /api/chat/sessions/:id',
  'GET /api/v1/datasets',
  'GET /api/v1/datasets/:id',
  'GET /api/v1/datasets/:id/rows',
  'GET /api/v1/memory',
  'GET /api/v1/memory/:id',
  'GET /api/v1/memory/:id/excerpts',
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
    for (const tenant of ['main', 'other'] as const) {
      for (const user of USER_KEYS) swept.set(`${tenant}/${user}`, await sweepHttp(seeded, tenant, user));
    }
  });

  for (const tenant of ['main', 'other'] as const satisfies readonly TenantKey[]) {
    for (const user of USER_KEYS satisfies readonly UserKey[]) {
      const who = `${tenant}/${user}`;
      const sightings = (): HttpSighting[] => swept.get(who) ?? [];

      it(`${who}: no forbidden canary in any response, apart from the known leak`, () => {
        const leaks = sightings().filter((s) => !s.verdict.allowed && !CHAT_SESSIONS_HAVE_NO_OWNER(s));
        assert.deepEqual(leaks, [], report(who, leaks));
      });

      it(`${who}: CONTROL — every content route returns the caller's own canaries`, () => {
        const routes = new Set(sightings().filter((s) => s.verdict.allowed).map((s) => s.route));
        assert.deepEqual([...routes].sort(), [...CONTENT_ROUTES].sort());
      });

      it(`${who}: known leak #1762: chat sessions show only the caller's own tabs`, { todo: '#1762' }, () => {
        const leaks = sightings().filter((s) => !s.verdict.allowed && CHAT_SESSIONS_HAVE_NO_OWNER(s));
        assert.deepEqual(leaks, [], report(who, leaks));
      });
    }
  }
});
