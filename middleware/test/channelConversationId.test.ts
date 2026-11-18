/**
 * #2043 rollout (D13) — the conversation id a facilitator's tools are told.
 *
 * For a bot with its own identity the Teams adapter's session scope is
 * `teams-<botKey>-<conversation id>`. The kernel stripped only `teams-`, so
 * the tool call context said the conversation was
 * `28:<appId>-19:meeting_…@thread.v2`; readiness asked Graph about that
 * string and no facilitation could start. The simulated channel of the
 * integration runs never used a bot-key scope.
 *
 * The channel now states its own id on the turn origin and the kernel uses it
 * as given. Reading the scope is the fallback and knows the bot-key form.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput } from '@omadia/channel-sdk';
import {
  buildToolCallContext,
  channelConversationId,
  conversationIdCandidates,
  wrapFacilitatorAgent,
} from '@omadia/orchestrator';

const BOT_KEY = '28:6e7d5e84-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const MEETING = '19:meeting_Mzc1NTYtYWJj-ZGVm@thread.v2';
const THREAD = '19:0a1b2c3d4e5f@thread.tacv2;messageid=1795012345678';

function turn(scopeId: string, extra: Record<string, unknown> = {}, channelType = 'teams'): ChatTurnInput {
  return {
    userMessage: '@Mona please run a vote',
    origin: {
      channelType,
      scope: { kind: 'conversation', conversationId: scopeId },
      conversationType: 'group',
      ...extra,
    },
  } as ChatTurnInput;
}

describe('channel-native conversation id of a turn', () => {
  it('uses the id the channel states, untouched, whatever the scope looks like', () => {
    const input = turn(`teams-${BOT_KEY}-${THREAD}`, { channelConversationId: THREAD });
    assert.equal(channelConversationId(input), THREAD);
    assert.deepEqual(conversationIdCandidates(input), [THREAD], 'exactly the stated id, no guesses beside it');
    // Opaque: per-thread suffix, case and odd characters are the channel's business.
    const odd = turn('teams-whatever', { channelConversationId: 'A:Mixed-Case;messageid=7;x=1' });
    assert.equal(channelConversationId(odd), 'A:Mixed-Case;messageid=7;x=1');
    assert.equal(buildToolCallContext('mona', input).conversationId, THREAD);
  });

  describe('fallback: the channel does not state it', () => {
    const cases: readonly [string, string, string, string][] = [
      ['a plain scope', MEETING, 'teams', MEETING],
      ['teams-<id>', `teams-${MEETING}`, 'teams', MEETING],
      ['teams-<botKey>-<id> (a bot with its own identity)', `teams-${BOT_KEY}-${MEETING}`, 'teams', MEETING],
      ['an id that itself contains "-"', `teams-${BOT_KEY}-19:a-b-c-d@thread.v2`, 'teams', '19:a-b-c-d@thread.v2'],
      ['a channel thread with ;messageid=', `teams-${BOT_KEY}-${THREAD}`, 'teams', THREAD],
      ['teams-<id> for a thread', `teams-${THREAD}`, 'teams', THREAD],
      ['<channelId>::<id>', `@acme/channel-x::room-7;messageid=3`, 'x', 'room-7;messageid=3'],
      ['an upper-case bot key', `teams-${BOT_KEY.toUpperCase()}-${MEETING}`, 'teams', MEETING],
    ];
    for (const [name, scopeId, channelType, expected] of cases) {
      it(name, () => {
        const input = turn(scopeId, {}, channelType);
        assert.equal(channelConversationId(input), expected);
        assert.ok(conversationIdCandidates(input).includes(expected));
        assert.equal(buildToolCallContext('mona', input).conversationId, expected);
      });
    }

    it('does not mistake a conversation id for a bot key', () => {
      // No GUID after the colon: nothing is stripped.
      for (const id of ['19:meeting_abc-def@thread.v2', '28:not-a-guid-19:x@thread.v2', 'a:1-2-3']) {
        assert.equal(channelConversationId(turn(`teams-${id}`)), id, id);
      }
      // A bot key with nothing after it is not a conversation.
      assert.equal(channelConversationId(turn(`teams-${BOT_KEY}-`)), `${BOT_KEY}-`);
    });

    it('offers every reading as a candidate, because it cannot know which the adapter used', () => {
      assert.deepEqual(conversationIdCandidates(turn(`teams-${BOT_KEY}-${MEETING}`)), [
        `teams-${BOT_KEY}-${MEETING}`,
        `${BOT_KEY}-${MEETING}`,
        MEETING,
      ]);
    });
  });

  it('a turn that is not in a conversation has none', () => {
    const personal = { userMessage: 'hi', origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'u1' } } } as ChatTurnInput;
    assert.equal(channelConversationId(personal), undefined);
    assert.deepEqual(conversationIdCandidates(personal), []);
    assert.equal(channelConversationId({ userMessage: 'hi' } as ChatTurnInput), undefined);
  });
});

describe('the facilitator turn entry asks about the right conversation', () => {
  function entry() {
    const asked: string[] = [];
    let ran = 0;
    const inner: ChatAgent = {
      chat: () => {
        ran += 1;
        return Promise.resolve({ text: 'model' } as never);
      },
      chatStream: (() => undefined) as never,
    };
    const subscribed = new Set<string>();
    const agent = wrapFacilitatorAgent(inner, {
      agentSlug: 'mona',
      isEngineUsable: () => true,
      isEngineDriven: (_slug, _type, conversationId) => {
        asked.push(conversationId);
        return subscribed.has(conversationId);
      },
    });
    return { agent, asked, subscribed, ran: () => ran };
  }

  it('per thread: a subscription for one thread of a channel does not silence another', async () => {
    const other = '19:0a1b2c3d4e5f@thread.tacv2;messageid=1795019999999';
    const h = entry();
    h.subscribed.add(THREAD);
    const inThread = await h.agent.chat(turn(`teams-${BOT_KEY}-${THREAD}`, { channelConversationId: THREAD }));
    assert.equal(inThread.text, '', 'the engine drives this thread: the channel turn is suppressed');
    const elsewhere = await h.agent.chat(turn(`teams-${BOT_KEY}-${other}`, { channelConversationId: other }));
    assert.equal(elsewhere.text, 'model', 'another thread of the same channel is another conversation');
    assert.deepEqual(h.asked, [THREAD, other], 'asked with the per-thread id, never with a stripped one');
  });

  it('fallback: a bot-key scope without the stated id still finds the subscription', async () => {
    const h = entry();
    h.subscribed.add(MEETING);
    const answer = await h.agent.chat(turn(`teams-${BOT_KEY}-${MEETING}`));
    assert.equal(answer.text, '');
    assert.equal(h.ran(), 0);
  });
});
