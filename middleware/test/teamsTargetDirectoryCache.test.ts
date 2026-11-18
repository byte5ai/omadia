/**
 * #2043 rollout (D8) — the picker that never finished loading with 725 chats.
 *
 * The route enumerated the whole tenant on every request and the browser gave
 * up first. The cache in front of it answers within a bounded wait
 * (`loading` instead of silence), runs one enumeration for all callers, keeps
 * the result, and searches and limits on the server.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createTeamsTargetDirectoryCache,
  pageOfTeamsTargets,
  TEAMS_TARGETS_MAX_LIMIT,
} from '../src/services/teamsTargetDirectoryCache.js';
import type { TeamsTargetDirectory } from '../src/services/teamsTargetDirectoryService.js';

function tenant(chats: number): TeamsTargetDirectory {
  return {
    teams: {
      available: true,
      items: [
        { id: 'c6031502-025c-4297-92c6-b734e17e46c5', displayName: 'omadia facilitator test team' },
        { id: '11111111-2222-4333-8444-555555555555', displayName: 'Vertrieb' },
      ],
    },
    chats: {
      available: true,
      items: Array.from({ length: chats }, (_, i) => ({
        id: `19:${String(i).padStart(4, '0')}@thread.v2`,
        topic: i === 700 ? 'Müsli-Runde' : null,
        chatType: 'group' as const,
        memberNames: i === 701 ? ['Anna Köhler', 'Bert Brandt'] : [`Person ${String(i)}`],
      })),
    },
  };
}

/** A load the test finishes by hand, and a wait that ends when told to. */
function slowTenant(directory: TeamsTargetDirectory) {
  let loads = 0;
  let finish: (() => void) | undefined;
  let timeUp: (() => void) | undefined;
  const cache = createTeamsTargetDirectoryCache({
    load: () => {
      loads += 1;
      return new Promise((resolve) => {
        finish = () => resolve(directory);
      });
    },
    sleep: () =>
      new Promise((resolve) => {
        timeUp = resolve;
      }),
  });
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  return { cache, loads: () => loads, finish: () => finish?.(), timeUp: () => timeUp?.(), tick };
}

describe('teams target directory: bounded, shared, searchable (#2043 D8)', () => {
  it('answers `loading` when the enumeration outlasts the wait, and the next call gets the result of the SAME enumeration', async () => {
    const h = slowTenant(tenant(725));
    const first = h.cache.get();
    await h.tick();
    h.timeUp();
    assert.deepEqual(await first, {
      teams: { available: false, reason: 'loading' },
      chats: { available: false, reason: 'loading' },
    });
    const second = h.cache.get();
    await h.tick();
    assert.equal(h.loads(), 1, 'a second caller joins the running enumeration');
    h.finish();
    const page = await second;
    assert.ok(page.chats.available);
    assert.equal(page.chats.total, 725);
    assert.equal(page.chats.items.length, 725);
    assert.equal(page.chats.truncated, false);
    // Kept: no third enumeration, and no wait.
    const third = await h.cache.get({ q: 'müsli' });
    assert.equal(h.loads(), 1);
    assert.ok(third.chats.available);
    assert.deepEqual(third.chats.items.map((chat) => chat.topic), ['Müsli-Runde']);
  });

  it('searches topic, member names, team names and ids on the server, and says how many there are', () => {
    const directory = tenant(725);
    const byMember = pageOfTeamsTargets(directory, { q: 'anna köh' });
    assert.ok(byMember.chats.available && byMember.teams.available);
    assert.deepEqual(byMember.chats.items.map((chat) => chat.id), ['19:0701@thread.v2']);
    assert.deepEqual([byMember.chats.total, byMember.chats.matched], [725, 1]);
    assert.equal(byMember.teams.matched, 0);
    const byTeam = pageOfTeamsTargets(directory, { q: 'FACILITATOR' });
    assert.ok(byTeam.teams.available);
    assert.deepEqual(byTeam.teams.items.map((team) => team.displayName), ['omadia facilitator test team']);
    const byId = pageOfTeamsTargets(directory, { q: '19:0003@' });
    assert.ok(byId.chats.available);
    assert.equal(byId.chats.matched, 1);
  });

  it('limits what is sent and marks the list as truncated instead of passing it off as complete', () => {
    const limited = pageOfTeamsTargets(tenant(725), { limit: 50 });
    assert.ok(limited.chats.available);
    assert.deepEqual(
      [limited.chats.items.length, limited.chats.total, limited.chats.matched, limited.chats.truncated],
      [50, 725, 725, true],
    );
    const huge = pageOfTeamsTargets(tenant(TEAMS_TARGETS_MAX_LIMIT + 5), { limit: 1_000_000 });
    assert.ok(huge.chats.available);
    assert.equal(huge.chats.items.length, TEAMS_TARGETS_MAX_LIMIT);
    assert.equal(huge.chats.truncated, true);
  });

  it('keeps an unavailable half apart from an available one, and does not keep a failure', async () => {
    let calls = 0;
    const cache = createTeamsTargetDirectoryCache({
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('graph down');
        if (calls === 2) {
          return {
            teams: { available: false, reason: 'lookup_failed' },
            chats: { available: false, reason: 'sign_in_required' },
          };
        }
        return { teams: tenant(1).teams, chats: { available: false, reason: 'sign_in_required' } };
      },
    });
    assert.deepEqual(await cache.get(), {
      teams: { available: false, reason: 'lookup_failed' },
      chats: { available: false, reason: 'lookup_failed' },
    });
    const second = await cache.get();
    assert.equal(second.chats.available === false && second.chats.reason, 'sign_in_required');
    const third = await cache.get();
    assert.equal(calls, 3, 'neither failure was kept');
    assert.equal(third.teams.available, true);
    assert.equal(third.chats.available === false && third.chats.reason, 'sign_in_required');
    await cache.get();
    assert.equal(calls, 3, 'a readable result is kept');
    await cache.get({ refresh: true });
    assert.equal(calls, 4, 'refresh enumerates again');
  });

  it('a kept result expires', async () => {
    let time = 0;
    let calls = 0;
    const cache = createTeamsTargetDirectoryCache({
      load: async () => {
        calls += 1;
        return tenant(2);
      },
      ttlMs: 1000,
      now: () => time,
    });
    await cache.get();
    time = 900;
    await cache.get();
    assert.equal(calls, 1);
    time = 2000;
    await cache.get();
    assert.equal(calls, 2);
  });
});
