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

import { applyAiDisclosure, InMemoryDisclosureSeenStore, resolveAiDisclosure } from '@omadia/channel-sdk';
import type { ChatAgent, ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import { runAsEngineTurn, wrapFacilitatorAgent } from '@omadia/orchestrator';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { createOwnIdentityPostLog } from '../src/channels/ownIdentityPostLog.js';
import { CONVERSATION, ENGINE, hubFixture, MARA_KEY, processOf, readAll } from './_helpers/conversationMessagesFixture.js';

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
    await readAll(fixture, 'mara');
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
        { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, message: { text: 'Hi.' } },
        // What `conversationSend@2` hands in once the scope authorized the post.
        { subscriptions: fixture.hub.subscriptionsOfProcess(ENGINE, processOf('mara').processId, 'mara') },
      );
    await send();
    assert.equal(posts.count('mara', 'teams', CONVERSATION), 1);
    outcome = { outcome: 'unreachable', reason: 'channel_error' };
    await send();
    assert.equal(posts.count('mara', 'teams', CONVERSATION), 1, 'a refused send is not a post');
  });
});

describe('facilitator group turn: what the model is told', () => {
  function capture(): { agent: ChatAgent; seen: ChatTurnInput[] } {
    const seen: ChatTurnInput[] = [];
    const inner: ChatAgent = {
      chat: (input) => {
        seen.push(input);
        return Promise.resolve({ text: 'ok' } as never);
      },
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        seen.push(input);
        yield { type: 'done', answer: 'ok', toolCalls: 0, iterations: 0 } as ChatStreamEvent;
      },
    };
    return {
      agent: wrapFacilitatorAgent(inner, { agentSlug: 'mara', isEngineUsable: () => true, isEngineDriven: () => false }),
      seen,
    };
  }

  it('a channel-started group turn carries the platform statement, before any hint of the caller', async () => {
    const f = capture();
    await f.agent.chat(INPUT);
    await collect(f.agent.chatStream({ ...INPUT, extraSystemHint: 'caller hint' }));
    assert.match(f.seen[0]?.extraSystemHint ?? '', /A GROUP conversation on teams\. You are present in it under your own identity/);
    assert.match(f.seen[0]?.extraSystemHint ?? '', /no facilitation is running in this conversation yet/);
    assert.match(f.seen[0]?.extraSystemHint ?? '', /You keep no memory between messages[^\n]*Record it with your tools in this same turn/);
    assert.match(f.seen[1]?.extraSystemHint ?? '', /then ask the group to confirm or adjust\.\n\ncaller hint$/);
    assert.equal(INPUT.extraSystemHint, undefined, 'the input of the caller is not changed');
  });

  it('an engine turn gets only what the engine said', async () => {
    const f = capture();
    await runAsEngineTurn({ pluginId: ENGINE }, () => f.agent.chat({ ...INPUT, extraSystemHint: 'engine state' }));
    assert.equal(f.seen[0]?.extraSystemHint, 'engine state');
  });
});

describe('facilitator fixed answers carry the agent AI disclosure (#2043)', () => {
  const never: ChatAgent = {
    chat: () => Promise.reject(new Error('the model must not run')),
    // eslint-disable-next-line require-yield
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      throw new Error('the model must not run');
    },
  };
  /** What an orchestrator's `discloseCliAnswer` does: resolve, fold once per scope. */
  function agentWithDisclosure(off = false) {
    const disclosure = resolveAiDisclosure({ locale: 'en', assistantName: 'Mara' })!;
    const seen = new InMemoryDisclosureSeenStore();
    return wrapFacilitatorAgent(never, {
      agentSlug: 'mara',
      locale: 'en',
      // The engine is not usable: a group turn gets the fixed "not set up" text.
      isEngineUsable: () => false,
      isEngineDriven: () => false,
      disclose: (answer) =>
        off
          ? { answer }
          : { answer: applyAiDisclosure(answer, { disclosure, scope: 'c1', seen }).text, aiDisclosure: disclosure },
    });
  }

  it('chat and chatStream: the sentence on the first answer, the carrier on every one', async () => {
    const agent = agentWithDisclosure();
    const first = await agent.chat(INPUT);
    assert.match(first.text, /\n\nThis response was generated by Mara, an AI system\.$/);
    assert.equal(first.aiDisclosure?.text, 'This response was generated by Mara, an AI system.');
    const events = await collect(agent.chatStream(INPUT));
    const done = events.at(-1) as { answer: string; aiDisclosure?: { text: string } };
    assert.doesNotMatch(done.answer, /AI system/, 'folded once per conversation');
    assert.ok(done.answer.length > 0);
    assert.equal(done.aiDisclosure?.text, 'This response was generated by Mara, an AI system.', 'a labelling channel reads the carrier');
  });

  it('an operator who turned the disclosure off gets the plain text; no wiring keeps the old behaviour', async () => {
    const off = await agentWithDisclosure(true).chat(INPUT);
    assert.doesNotMatch(off.text, /AI system/);
    assert.equal(off.aiDisclosure, undefined);
    const plain = await wrapFacilitatorAgent(never, { agentSlug: 'mara', isEngineUsable: () => false }).chat(INPUT);
    assert.equal(plain.aiDisclosure, undefined);
    assert.ok(plain.text.length > 0);
  });

  it('a suppressed turn (the engine drives the conversation) stays empty and unmarked', async () => {
    let asked = 0;
    const agent = wrapFacilitatorAgent(never, {
      agentSlug: 'mara',
      isEngineUsable: () => true,
      isEngineDriven: () => true,
      disclose: (answer) => {
        asked += 1;
        return { answer: `${answer} marked` };
      },
    });
    assert.equal((await agent.chat(INPUT)).text, '');
    assert.equal(asked, 0);
  });
});
