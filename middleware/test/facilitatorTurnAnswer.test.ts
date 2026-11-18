/**
 * #2043 — one message, not two, when a facilitation opens.
 *
 * Found in the integration run with the real engine: the mention that opens a
 * facilitation runs a kernel turn; inside it the engine posts the handshake as
 * the facilitator, and then the channel posted the turn's own answer next to
 * it (the model's paraphrase of the rules). The kernel counts what went out as
 * the facilitator's own identity and drops the answer of a channel-started
 * turn during which the engine posted. A turn in which the engine posted
 * nothing (the setup is still being agreed) keeps its answer.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import { runAsEngineTurn, wrapFacilitatorAgent } from '@omadia/orchestrator';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { createOwnIdentityPostLog } from '../src/channels/ownIdentityPostLog.js';
import { CONVERSATION, ENGINE, hubFixture, MARA_KEY, scopeOf } from './_helpers/conversationMessagesFixture.js';

const INPUT: ChatTurnInput = {
  userMessage: '@Mara please run a vote',
  origin: {
    channelType: 'teams',
    scope: { kind: 'conversation', conversationId: `teams-${CONVERSATION}` },
    conversationType: 'group',
  },
} as ChatTurnInput;

/** A model turn that "calls a tool" (`duringTurn`) and then answers. */
function facilitator(duringTurn: () => void) {
  const posts = createOwnIdentityPostLog();
  const logs: string[] = [];
  const inner: ChatAgent = {
    chat: () => {
      duringTurn.call(undefined);
      return Promise.resolve({ text: 'The vote is open, here are the rules again.' } as never);
    },
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: 'text_delta', text: 'The vote ' } as ChatStreamEvent;
      duringTurn.call(undefined);
      yield { type: 'text_delta', text: 'is open.' } as ChatStreamEvent;
      yield { type: 'done', answer: 'The vote is open.', toolCalls: 1, iterations: 2 } as ChatStreamEvent;
    },
  };
  const agent = wrapFacilitatorAgent(inner, {
    agentSlug: 'mara',
    isEngineUsable: () => true,
    isEngineDriven: () => false,
    ownPostCount: posts.count,
    log: (m) => logs.push(m),
  });
  return { agent, posts, logs };
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('facilitator turn answer vs. the engine posting in the same turn', () => {
  it('chat: the answer is dropped when the engine posted as the facilitator during the turn', async () => {
    const f = facilitator(() => f.posts.record('mara', 'teams', CONVERSATION));
    assert.equal((await f.agent.chat(INPUT)).text, '');
    assert.match(f.logs.join('\n'), /turn answer dropped: the facilitation engine posted in this turn/);
  });

  it('chatStream: what was streamed is retracted and the final answer is empty', async () => {
    const f = facilitator(() => f.posts.record('mara', 'teams', CONVERSATION));
    const events = await collect(f.agent.chatStream(INPUT));
    assert.deepEqual(
      events.map((e) => e.type),
      ['text_delta', 'text_delta', 'text_retract', 'done'],
    );
    assert.deepEqual(events[2], { type: 'text_retract', chars: 'The vote is open.'.length });
    const done = events[3] as { answer: string; toolCalls: number };
    assert.equal(done.answer, '');
    assert.equal(done.toolCalls, 1, 'the rest of the result is untouched');
  });

  it('the answer stays when the engine posted nothing (the setup is still being agreed)', async () => {
    const f = facilitator(() => undefined);
    assert.equal((await f.agent.chat(INPUT)).text, 'The vote is open, here are the rules again.');
    const events = await collect(f.agent.chatStream(INPUT));
    assert.equal((events.at(-1) as { answer: string }).answer, 'The vote is open.');
  });

  it('posts in another conversation or by another agent do not count', async () => {
    const f = facilitator(() => {
      f.posts.record('mara', 'teams', '19:another@thread.v2');
      f.posts.record('nora', 'teams', CONVERSATION);
    });
    assert.equal((await f.agent.chat(INPUT)).text, 'The vote is open, here are the rules again.');
  });

  it('an engine turn keeps its text: the engine decides what is posted', async () => {
    const f = facilitator(() => f.posts.record('mara', 'teams', CONVERSATION));
    const answer = await runAsEngineTurn({ pluginId: ENGINE }, () => f.agent.chat(INPUT));
    assert.equal(answer.text, 'The vote is open, here are the rules again.');
  });

  it('the send service counts delivered own-identity posts only', async () => {
    const fixture = hubFixture(new InMemoryConversationMessageStore());
    await fixture.hub.subscribe(scopeOf('mara'), ENGINE);
    const posts = createOwnIdentityPostLog();
    let outcome: { outcome: 'delivered'; messageId: string } | { outcome: 'unreachable'; reason: 'channel_error' } = {
      outcome: 'delivered',
      messageId: 'm1',
    };
    const providers = new ConversationSendRegistry();
    providers.register('@omadia/channel-teams', {
      channelType: 'teams',
      supports: { asChannelKey: true },
      sendToConversation: () => Promise.resolve(outcome as never),
    });
    const service = createConversationSendService({
      providers,
      ownIdentity: {
        identityFor: (slug: string) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
        subscriptions: fixture.hub,
        getRoster: () => Promise.resolve(undefined),
      } as never,
      onOwnIdentityDelivered: posts.record,
    });
    const send = () =>
      service.sendToConversation(
        { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, message: { text: 'Hi.' }, asOwnIdentity: true },
        ENGINE,
      );
    await send();
    assert.equal(posts.count('mara', 'teams', CONVERSATION), 1);
    outcome = { outcome: 'unreachable', reason: 'channel_error' };
    await send();
    assert.equal(posts.count('mara', 'teams', CONVERSATION), 1, 'a refused send is not a post');
  });
});
