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
  const waiting: (() => void)[] = [];
  const cache = createTeamsTargetDirectoryCache({
    loadTeams: async () => directory.teams,
    loadChats: () => {
      loads += 1;
      return new Promise((resolve) => {
        finish = () => resolve(directory.chats);
      });
    },
    sleep: () =>
      new Promise((resolve) => {
        waiting.push(resolve);
      }),
  });
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  return { cache, loads: () => loads, finish: () => finish?.(), timeUp: () => waiting.splice(0).forEach((resolve) => resolve()), tick };
}

describe('teams target directory: bounded, shared, searchable (#2043 D8)', () => {
  it('answers `loading` when the enumeration outlasts the wait, and the next call gets the result of the SAME enumeration', async () => {
    const h = slowTenant(tenant(725));
    const first = h.cache.get();
    await h.tick();
    h.timeUp();
    const early = await first;
    assert.deepEqual(early.chats, { available: false, reason: 'loading' });
    assert.equal(early.teams.available, true, 'the short team list does not wait for the chats');
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
    let teamCalls = 0;
    let chatCalls = 0;
    const cache = createTeamsTargetDirectoryCache({
      loadTeams: async () => {
        teamCalls += 1;
        if (teamCalls === 1) throw new Error('graph down');
        if (teamCalls === 2) return { available: false, reason: 'lookup_failed' };
        return tenant(1).teams;
      },
      loadChats: async () => {
        chatCalls += 1;
        return { available: false, reason: 'sign_in_required' };
      },
    });
    const first = await cache.get();
    assert.deepEqual(first.teams, { available: false, reason: 'lookup_failed' }, 'a thrown load is "could not look"');
    assert.deepEqual(first.chats, { available: false, reason: 'sign_in_required' });
    await cache.get();
    const third = await cache.get();
    assert.equal(teamCalls, 3, 'neither failure was kept');
    assert.equal(chatCalls, 3, 'an unavailable half is asked again');
    assert.equal(third.teams.available, true);
    await cache.get();
    assert.equal(teamCalls, 3, 'a readable result is kept');
    await cache.get({ refresh: true });
    assert.equal(teamCalls, 4, 'refresh enumerates again');
  });

  it('a kept result expires', async () => {
    let time = 0;
    let calls = 0;
    const cache = createTeamsTargetDirectoryCache({
      loadTeams: async () => tenant(2).teams,
      loadChats: async () => {
        calls += 1;
        return tenant(2).chats;
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

  it('connector 0.9.1: an incomplete source list is reported, and so is whose members a search can match', () => {
    // Titled chats carry no member names any more; untitled ones do, up to
    // the connector's lookup budget.
    const directory: TeamsTargetDirectory = {
      teams: { available: true, items: [{ id: 't1', displayName: 'Vertrieb' }], sourceTruncated: false },
      chats: {
        available: true,
        sourceTruncated: true,
        withoutMemberNames: 2,
        items: [
          { id: '19:a@thread.v2', topic: 'Müsli-Runde', chatType: 'group' },
          { id: '19:b@thread.v2', topic: null, chatType: 'group', memberNames: ['Anna Köhler', 'Bert Brandt'] },
          { id: '19:c@thread.v2', topic: null, chatType: 'oneOnOne' },
        ],
      },
    };
    const all = pageOfTeamsTargets(directory);
    assert.ok(all.chats.available && all.teams.available);
    assert.equal(all.teams.sourceTruncated, false);
    assert.equal(all.teams.truncated, false);
    assert.equal(all.chats.sourceTruncated, true);
    assert.equal(all.chats.truncated, true, 'incomplete at the source counts as truncated, whatever the limit');
    assert.equal(all.chats.withoutMemberNames, 2);
    assert.equal(all.chats.memberSearch, 'untitled_only');
    // A member name finds the untitled chat; the titled one is found by its topic only.
    const byMember = pageOfTeamsTargets(directory, { q: 'anna' });
    assert.ok(byMember.chats.available);
    assert.deepEqual(byMember.chats.items.map((chat) => chat.id), ['19:b@thread.v2']);
  });

  it('connector 0.9.0 (titled chats carry members, no marks): unchanged, and said so', () => {
    const page = pageOfTeamsTargets(tenant(3));
    assert.ok(page.chats.available);
    assert.equal(page.chats.sourceTruncated, false);
    assert.equal(page.chats.truncated, false);
    assert.equal(page.chats.withoutMemberNames, undefined);
    assert.equal(page.chats.memberSearch, 'untitled_only');
    const titledWithMembers: TeamsTargetDirectory = {
      teams: { available: true, items: [] },
      chats: {
        available: true,
        items: [{ id: '19:a@thread.v2', topic: 'Lunch', chatType: 'group', memberNames: ['Anna Köhler'] }],
      },
    };
    const old = pageOfTeamsTargets(titledWithMembers, { q: 'anna' });
    assert.ok(old.chats.available);
    assert.equal(old.chats.memberSearch, 'all');
    assert.equal(old.chats.matched, 1, 'still found by member, as before');
    const none = pageOfTeamsTargets({
      teams: { available: true, items: [] },
      chats: { available: true, items: [{ id: '19:a@thread.v2', topic: 'Lunch', chatType: 'group' }] },
    });
    assert.ok(none.chats.available);
    assert.equal(none.chats.memberSearch, 'none');
  });

  it('#2043 D8 — chats are not enumerated unless asked for', async () => {
    let chatLoads = 0;
    const cache = createTeamsTargetDirectoryCache({
      loadTeams: async () => tenant(1).teams,
      loadChats: async () => {
        chatLoads += 1;
        return tenant(3).chats;
      },
    });
    const page = await cache.get({ chats: false });
    assert.equal(page.teams.available, true);
    assert.deepEqual(page.chats, { available: false, reason: 'not_requested' });
    assert.equal(chatLoads, 0);
    const searched = await cache.get({ q: 'person 1' });
    assert.equal(chatLoads, 1);
    assert.ok(searched.chats.available);
    assert.equal(searched.chats.matched, 1);
  });

  it('#2043 D14 — concurrent callers share ONE enumeration, and every later caller is served from it', async () => {
    const h = slowTenant(tenant(4560));
    const callers = [h.cache.get(), h.cache.get({ q: 'x' }), h.cache.get({ limit: 5 })];
    await h.tick();
    assert.equal(h.loads(), 1, 'three concurrent requests, one enumeration');
    h.timeUp();
    for (const page of await Promise.all(callers)) {
      assert.deepEqual(page.chats, { available: false, reason: 'loading' });
    }
    // More requests while it is still running do not start another one.
    const late = h.cache.get();
    await h.tick();
    assert.equal(h.loads(), 1);
    h.finish();
    assert.ok((await late).chats.available);
    // The request after completion gets the list, without a new enumeration
    // and without waiting.
    for (let i = 0; i < 5; i += 1) {
      const page = await h.cache.get();
      assert.ok(page.chats.available);
      assert.equal(page.chats.total, 4560);
    }
    assert.equal(h.loads(), 1);
  });
});
