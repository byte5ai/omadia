/**
 * #2043 D14 — the targets ROUTE against a slow source.
 *
 * #2095 put a shared, cached enumeration in front of the team/chat directory
 * and tested the cache object on its own. In the route the cache was looked
 * up in a WeakMap keyed by the object `getTeamsIdentity()` returns, and the
 * production wiring builds that object anew for every request. So every
 * request got a fresh, empty cache, started its own minute-long enumeration
 * and answered `loading`, for ever; a finished enumeration was never served.
 *
 * These tests go through the real router, with a `getTeamsIdentity` that
 * returns a NEW object per call (as production does) and a source that takes
 * as long as the test says. Either of the two would have caught it.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

interface Targets {
  teams: { available: boolean; reason?: string; items?: { id: string }[] };
  chats: { available: boolean; reason?: string; items?: { id: string }[]; total?: number; matched?: number };
  recent: { available: boolean; reason?: string; items?: { id: string; kind: string; label: string | null; knownToThisBot: boolean }[] };
}

describe('GET /:slug/teams/targets with a slow tenant (#2043 D8, D14)', () => {
  let server: Server;
  let baseUrl: string;
  let chatEnumerations = 0;
  let teamEnumerations = 0;
  let depsBuilt = 0;
  let finishChats: (() => void) | undefined;
  let chatsDone = false;

  const CHATS = Array.from({ length: 4560 }, (_, i) => ({
    id: `19:${String(i).padStart(5, '0')}@thread.v2`,
    topic: i === 4000 ? 'Safeword-Runde' : null,
    chatType: 'group' as const,
  }));

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () =>
          ({
            getAgentBySlug: (slug: string) =>
              Promise.resolve(slug === 'mona' ? { id: 'agent-1', slug: 'mona', name: 'Mona' } : undefined),
          }) as unknown as ConfigStore,
        getRegistry: () => ({ reload: () => Promise.resolve() }) as unknown as OrchestratorRegistry,
        getChatSessionStore: () => undefined,
        // A NEW object on every call: exactly what src/index.ts does.
        getTeamsIdentity: () => {
          depsBuilt += 1;
          return {
            store: {
              getByAgentId: () => Promise.resolve({ agentId: 'agent-1', appId: 'APP-MONA' } as never),
              ensureForAgent: () => Promise.reject(new Error('not used')),
            },
            runner: { enqueue: () => Promise.resolve(undefined), isRunning: () => false, runningTeamId: () => null },
            isProvisionerInstalled: () => true,
            getProvisioner: () =>
              ({
                listTeams: async () => {
                  teamEnumerations += 1;
                  return [{ id: 'c6031502-025c-4297-92c6-b734e17e46c5', displayName: 'omadia facilitator test team' }];
                },
                listChats: () => {
                  chatEnumerations += 1;
                  return new Promise((resolve) => {
                    finishChats = () => {
                      chatsDone = true;
                      resolve(CHATS);
                    };
                  });
                },
              }) as never,
            delegatedTokens: { read: () => Promise.resolve({ accessToken: 'x' } as never) },
            recentConversations: async () => [
              { conversationId: '19:meeting_abc@thread.v2', teamsType: 'groupChat', name: 'Testbesprechung', updatedAt: new Date('2026-11-18T17:05:00Z'), botAppIds: ['app-mona'] },
              { conversationId: '19:9cdb0cd5@thread.skype;messageid=17', teamsType: 'groupChat', name: null, updatedAt: new Date('2026-11-18T12:00:00Z'), botAppIds: ['app-other'] },
              { conversationId: 'a:1personal', teamsType: 'personal', name: null, updatedAt: new Date('2026-11-18T18:00:00Z'), botAppIds: ['app-mona'] },
              { conversationId: '19:abc@thread.tacv2;messageid=5', teamsType: 'channel', name: 'General', updatedAt: new Date('2026-11-18T18:00:00Z'), botAppIds: ['app-mona'] },
            ],
          } as never;
        },
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/operator/agents`;
  });

  after(async () => {
    finishChats?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const get = async (query = ''): Promise<Targets> => {
    const res = await fetch(`${baseUrl}/mona/teams/targets${query}`);
    assert.equal(res.status, 200);
    return (await res.json()) as Targets;
  };

  it('the default answer needs no chat enumeration: teams, and the conversations the bots already know', async () => {
    const page = await get();
    assert.equal(chatEnumerations, 0, 'opening the picker does not page through the tenant');
    assert.equal(page.teams.available, true);
    assert.deepEqual(page.chats, { available: false, reason: 'not_requested' });
    assert.equal(page.recent.available, true);
    assert.deepEqual(
      page.recent.items?.map((item) => [item.id, item.kind, item.label, item.knownToThisBot]),
      [
        ['19:meeting_abc@thread.v2', 'group-chat', 'Testbesprechung', true],
        ['19:9cdb0cd5@thread.skype', 'group-chat', null, false],
      ],
      'only installable chats; this bot first; the thread suffix is not part of a chat id',
    );
  });

  it('a search enumerates once, however many requests arrive, and a finished enumeration is served to the next request', async () => {
    // Five polls and a second operator while the source is still paging.
    // (The route waits 8 s for a result; these run concurrently instead.)
    const pending = Promise.all([get('?q=safe'), get('?q=safe'), get('?chats=all'), get('?q=runde')]);
    for (let i = 0; i < 50 && chatEnumerations === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(chatEnumerations, 1, 'four concurrent requests share one enumeration');
    assert.ok(depsBuilt >= 4, 'each request built its own deps object, as in production');
    finishChats?.();
    const pages = await pending;
    assert.ok(chatsDone);
    assert.equal(pages[0]?.chats.available, true);
    assert.deepEqual(pages[0]?.chats.items?.map((c) => c.id), ['19:04000@thread.v2']);
    assert.deepEqual([pages[0]?.chats.total, pages[0]?.chats.matched], [4560, 1]);
    assert.equal(pages[2]?.chats.items?.length, 1000, 'the full list is limited, and says so');

    // The request AFTER completion: served from the kept result, at once.
    const started = Date.now();
    const next = await get('?q=safeword');
    assert.equal(next.chats.available, true, 'not "loading" again');
    assert.equal(next.chats.matched, 1);
    assert.ok(Date.now() - started < 2000);
    await get('?chats=all');
    await get('?q=x');
    assert.equal(chatEnumerations, 1, 'no new enumeration for any later request');
    assert.equal(teamEnumerations, 1, 'the team list is kept as well');
  });
});
