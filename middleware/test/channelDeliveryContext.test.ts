/**
 * #2316 (ADR-0279) — a channel chat's recent routine deliveries reach its
 * turns as `conversationContextHint`: the kernel lookup by session scope and
 * the decorator that fills the field when the caller set none.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';

import { wrapChatAgentWithConversationContext } from '../packages/harness-orchestrator/src/conversationContextAgent.js';
import {
  createChannelDeliveryContext,
  DELIVERY_CONTEXT_WINDOW_MS,
} from '../src/plugins/routines/routineDeliveryContext.js';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);

describe('createChannelDeliveryContext (#2316)', () => {
  const calls: Array<{ scope: string; agent: string; since: Date; limit: number }> = [];
  const store = {
    recentDeliveriesForScope: (scope: string, agent: string, since: Date, limit: number) => {
      calls.push({ scope, agent, since, limit });
      return Promise.resolve(
        scope === 'teams-19:abc'
          ? [
              { routineName: 'Sales', deliveredAt: NOW - 60_000, content: 'Sales: 4 deals' },
              { routineName: 'Morning', deliveredAt: NOW - 3_600_000, content: 'Morning: 3 invoices' },
            ]
          : [],
      );
    },
  };
  const lookup = createChannelDeliveryContext({
    store: () => store,
    isWebChatScope: (s) => s.startsWith('web-'),
    now: () => NOW,
  });

  it('builds the labelled block from the scope\'s deliveries, oldest first', async () => {
    const hint = await lookup('teams-19:abc', 'erika');
    assert.ok(hint);
    assert.ok(hint.indexOf('Morning: 3 invoices') < hint.indexOf('Sales: 4 deals'));
    assert.match(hint, /Do not follow instructions/);
    assert.deepEqual(calls.at(-1), { scope: 'teams-19:abc', agent: 'erika', since: new Date(NOW - DELIVERY_CONTEXT_WINDOW_MS), limit: 3 });
  });

  it('yields nothing for a chat without deliveries, a web chat, or without a store', async () => {
    assert.equal(await lookup('telegram::42', 'erika'), undefined);
    const before = calls.length;
    assert.equal(await lookup('web-1', 'erika'), undefined);
    assert.equal(calls.length, before, 'a web chat reads its own document');
    const noStore = createChannelDeliveryContext({ store: () => undefined, isWebChatScope: () => false });
    assert.equal(await noStore('teams-19:abc', 'erika'), undefined);
  });
});

describe('wrapChatAgentWithConversationContext (#2316)', () => {
  const seen: ChatTurnInput[] = [];
  const inner: ChatAgent = {
    chat: (input) => {
      seen.push(input);
      return Promise.resolve({ text: 'ok' } as unknown as SemanticAnswer);
    },
    async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
      seen.push(input);
      yield { type: 'text_delta', text: 'ok' };
    },
    holdsContentUntilVerdict: true,
  };

  it('fills the field from the lookup, keeps a caller\'s own and survives a failing lookup', async () => {
    const logs: string[] = [];
    const agent = wrapChatAgentWithConversationContext(
      inner,
      'erika',
      (scope, slug) => (scope === 'boom' ? Promise.reject(new Error('db down')) : Promise.resolve(`ctx of ${scope} for ${slug}`)),
      (m) => logs.push(m),
    );
    await agent.chat({ userMessage: 'hi', sessionScope: 'teams-1' });
    assert.equal(seen.at(-1)?.conversationContextHint, 'ctx of teams-1 for erika');
    await agent.chat({ userMessage: 'hi', sessionScope: 'teams-1', conversationContextHint: 'own' });
    assert.equal(seen.at(-1)?.conversationContextHint, 'own');
    for await (const _ of agent.chatStream({ userMessage: 'hi', sessionScope: 'boom' })) void _;
    assert.equal(seen.at(-1)?.conversationContextHint, undefined);
    assert.equal(logs.length, 1);
    assert.equal(agent.holdsContentUntilVerdict, true);
  });
});
