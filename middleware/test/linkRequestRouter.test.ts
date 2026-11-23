/**
 * #2089 (spec 2043 §5.3, criterion 48) — link requests: a message that
 * addresses a facilitator inside a conversation none of its processes reads
 * goes to the archetype plugin as a typed request, recorded by the kernel,
 * without storing the message or granting read access.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LinkRequest } from '@omadia/plugin-api';

import { LinkRequestRouter } from '../src/channels/linkRequestRouter.js';
import type { NewLinkRequest } from '../src/execution/sessionConversationStore.js';
import { createFacilitatorRuntimeLookup } from '../src/platform/facilitatorRuntimeService.js';

const ENGINE = '@omadia/agent-facilitator';
const MEETING = '19:meeting_xyz@thread.v2';

function setup(opts: { processes?: string[]; read?: boolean } = {}) {
  const created: NewLinkRequest[] = [];
  const dropped: string[] = [];
  const router = new LinkRequestRouter({
    sessions: () => ({
      linkingProcesses: () => Promise.resolve(opts.processes ?? ['fac-1']),
      createLinkRequest: (input) => {
        created.push(input);
        return Promise.resolve({ id: `lr-${String(created.length)}`, expiresAt: '2026-11-20T15:00:00.000Z' });
      },
      dropLinkRequest: (id) => {
        dropped.push(id);
        return Promise.resolve();
      },
    }),
    isRead: () => opts.read === true,
    timeoutMs: 50,
  });
  const turn = {
    agent: { id: 'agent-mara', slug: 'mara' },
    channelType: 'teams',
    conversationIds: [MEETING],
    principalId: 'aad-anna',
    text: '@Mara link this chat to "Offsite planning"',
    messageId: 'msg-1',
  };
  return { router, created, dropped, turn };
}

describe('#2089 link requests', () => {
  it('reaches the plugin as a typed request with the turn author, and is recorded', async () => {
    const s = setup();
    const seen: LinkRequest[] = [];
    s.router.register(ENGINE, 'mara', (request) => {
      seen.push(request);
      return Promise.resolve({ handled: true });
    });
    assert.deepEqual(await s.router.route(s.turn), {});
    assert.equal(seen.length, 1);
    assert.deepEqual(
      { id: seen[0]!.linkRequestId, conv: seen[0]!.conversationId, who: seen[0]!.principalId, processes: seen[0]!.processIds },
      { id: 'lr-1', conv: MEETING, who: 'aad-anna', processes: ['fac-1'] },
    );
    assert.equal(s.created[0]?.conversationId, MEETING);
    assert.deepEqual(s.dropped, []);
  });

  it('a short answer of the plugin becomes the turn\'s answer', async () => {
    const s = setup();
    s.router.register(ENGINE, 'mara', () => Promise.resolve({ handled: true, answer: 'Only a participant of that facilitation can link this chat.' }));
    assert.deepEqual(await s.router.route(s.turn), { answer: 'Only a participant of that facilitation can link this chat.' });
  });

  it('declined, failed or too slow: the ordinary turn answers and the request is dropped', async () => {
    for (const handler of [
      () => Promise.resolve({ handled: false as const }),
      () => Promise.reject(new Error('boom')),
      () => new Promise<never>(() => undefined),
    ]) {
      const s = setup();
      s.router.register(ENGINE, 'mara', handler);
      assert.equal(await s.router.route(s.turn), undefined);
      assert.deepEqual(s.dropped, ['lr-1']);
    }
  });

  it('is not a link request where a process already reads, or no process could link', async () => {
    for (const opts of [{ read: true }, { processes: [] }]) {
      const s = setup(opts);
      let asked = false;
      s.router.register(ENGINE, 'mara', () => {
        asked = true;
        return Promise.resolve({ handled: true });
      });
      assert.equal(await s.router.route(s.turn), undefined);
      assert.equal(asked, false);
      assert.deepEqual(s.created, []);
    }
  });

  it('the kernel lookup asks the link route after the addressed route declined', async () => {
    const s = setup();
    s.router.register(ENGINE, 'mara', () => Promise.resolve({ handled: true, answer: 'Linked? Not from here.' }));
    const lookup = createFacilitatorRuntimeLookup({
      getRegistry: () => ({ get: () => ({ agent: { id: 'agent-mara', slug: 'mara' } }) }) as never,
      getMessages: () => undefined,
      engineSources: () => ({}) as never,
      reportedEngineState: () => undefined,
      getAddressedMessages: () => ({ route: () => Promise.resolve(false) }),
      getLinkRequests: () => s.router,
    });
    const taken = await lookup.addressedTurn!('mara', { channelType: 'teams', conversationIds: [MEETING], principalId: 'aad-anna', text: 'link' });
    assert.deepEqual(taken, { answer: 'Linked? Not from here.' });
  });
});
