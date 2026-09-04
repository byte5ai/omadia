import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ambientTurnFrom,
  createDiscussionsCapability,
  DiscussionNoConversationError,
  DiscussionUnknownOpenerError,
} from '../src/conductor/discussionHere.js';
import {
  createDiscussionStartHandler,
  discussionStartToolSpec,
} from '@omadia/plugin-discussion';

// Starting a discussion FROM A CHAT. The capability takes neither the
// conversation nor the opener: both are read off the inbound turn, because a
// tool plugin is registered once per process and can know neither.

const HR_BOT = '28:aaaaaaaa-1111-2222-3333-444444444444';

/** What a Bot-Framework ConversationReference looks like to us. */
const teamsRef = (over: Record<string, unknown> = {}) => ({
  channel: 'teams',
  conversationRef: {
    conversation: { id: '19:chat@thread.v2' },
    bot: { id: HR_BOT, name: 'HR' },
    ...over,
  },
});

describe('ambientTurnFrom', () => {
  it('reads conversation and addressed bot out of a Teams turn', () => {
    assert.deepEqual(ambientTurnFrom(teamsRef()), {
      channelType: 'teams',
      conversationId: '19:chat@thread.v2',
      botChannelKey: HR_BOT,
    });
  });

  it('returns the conversation without a bot when the reference carries none', () => {
    const turn = ambientTurnFrom({ channel: 'teams', conversationRef: { conversation: { id: 'c1' } } });
    assert.deepEqual(turn, { channelType: 'teams', conversationId: 'c1' });
  });

  it('returns undefined outside a channel turn', () => {
    assert.equal(ambientTurnFrom(undefined), undefined);
    assert.equal(ambientTurnFrom({ channel: '', conversationRef: { conversation: { id: 'c' } } }), undefined);
  });

  it('returns undefined on a reference it does not recognise — never a guess', () => {
    assert.equal(ambientTurnFrom({ channel: 'teams', conversationRef: 'nope' }), undefined);
    assert.equal(ambientTurnFrom({ channel: 'teams', conversationRef: {} }), undefined);
    assert.equal(ambientTurnFrom({ channel: 'teams', conversationRef: { conversation: { id: '  ' } } }), undefined);
  });
});

function capabilityHarness(over: { turn?: unknown; opener?: string | undefined } = {}) {
  const started: unknown[] = [];
  const capability = createDiscussionsCapability({
    discussions: {
      start: async (input: unknown) => {
        started.push(input);
        return {
          runId: 'run-1',
          workflowId: 'wf-1',
          workflowSlug: 'eph-discussion-abc',
          expiresAt: new Date(0).toISOString(),
        };
      },
    } as never,
    resolveTurn: () =>
      over.turn === undefined
        ? { channelType: 'teams', conversationId: '19:chat@thread.v2', botChannelKey: HR_BOT }
        : (over.turn as never),
    resolveOpener: () => ('opener' in over ? over.opener : 'hr'),
  });
  return { capability, started };
}

describe('conductorDiscussions.startHere', () => {
  it('derives conversation AND opener from the turn — the caller supplies neither', async () => {
    const { capability, started } = capabilityHarness();
    const handle = await capability.startHere({ agentB: 'accounting', topic: 'Weiterbildungsbudgets' });
    assert.equal(handle.runId, 'run-1');
    assert.deepEqual(started[0], {
      channelType: 'teams',
      conversationId: '19:chat@thread.v2',
      agentA: 'hr',
      agentB: 'accounting',
      topic: 'Weiterbildungsbudgets',
    });
  });

  it('passes an explicit guiding question through', async () => {
    const { capability, started } = capabilityHarness();
    await capability.startHere({ agentB: 'accounting', topic: 'T', guidingQuestion: 'Wer zahlt?' });
    assert.equal((started[0] as { guidingQuestion?: string }).guidingQuestion, 'Wer zahlt?');
  });

  it('refuses outside a channel turn — no conversation to start in', async () => {
    const { capability, started } = capabilityHarness({ turn: undefined as never });
    const noTurn = createDiscussionsCapability({
      discussions: { start: async () => ({}) } as never,
      resolveTurn: () => undefined,
      resolveOpener: () => 'hr',
    });
    void capability;
    await assert.rejects(() => noTurn.startHere({ agentB: 'accounting', topic: 'T' }), DiscussionNoConversationError);
    assert.deepEqual(started, []);
  });

  it('refuses when the receiving bot maps to no agent — the opener decides whose name appears', async () => {
    const { capability, started } = capabilityHarness({ opener: undefined });
    await assert.rejects(
      () => capability.startHere({ agentB: 'accounting', topic: 'T' }),
      DiscussionUnknownOpenerError,
    );
    assert.deepEqual(started, []);
  });

  it('refuses when the turn carries no bot identity at all', async () => {
    const { capability } = capabilityHarness({
      turn: { channelType: 'teams', conversationId: '19:chat@thread.v2' },
    });
    await assert.rejects(
      () => capability.startHere({ agentB: 'accounting', topic: 'T' }),
      DiscussionUnknownOpenerError,
    );
  });
});

// --- the tool the model actually calls -------------------------------------

describe('discussion_start tool', () => {
  it('exposes with_agent + topic as the only required inputs', () => {
    assert.deepEqual(discussionStartToolSpec.input_schema.required, ['with_agent', 'topic']);
    const props = Object.keys(discussionStartToolSpec.input_schema.properties).sort();
    assert.deepEqual(props, ['guiding_question', 'topic', 'with_agent']);
    // No conversation and no opener on the model-facing surface.
    assert.equal(props.includes('conversation_id'), false);
    assert.equal(props.includes('as_agent'), false);
  });

  it('starts the discussion and tells the model to stop talking', async () => {
    const calls: unknown[] = [];
    const handler = createDiscussionStartHandler({
      discussions: {
        startHere: async (input: unknown) => {
          calls.push(input);
          return { runId: 'run-1', workflowSlug: 'eph-discussion-abc', expiresAt: '1970-01-01T00:00:00.000Z' };
        },
      },
    });
    const out = await handler({ with_agent: 'accounting', topic: 'Weiterbildungsbudgets' });
    const parsed = JSON.parse(out) as { started: boolean; with_agent: string; note: string };
    assert.equal(parsed.started, true);
    assert.equal(parsed.with_agent, 'accounting');
    assert.match(parsed.note, /do not repeat the topic/i);
    assert.deepEqual(calls, [{ agentB: 'accounting', topic: 'Weiterbildungsbudgets' }]);
  });

  it('rejects a malformed agent slug before reaching the kernel', async () => {
    const handler = createDiscussionStartHandler({
      discussions: {
        startHere: async () => assert.fail('must not reach the kernel'),
      },
    });
    const out = await handler({ with_agent: 'NOT A SLUG', topic: 'T' });
    assert.match(out, /^Error: /);
  });

  it('requires a topic', async () => {
    const handler = createDiscussionStartHandler({ discussions: undefined });
    assert.match(await handler({ with_agent: 'accounting' }), /^Error: /);
  });

  it('explains a missing kernel seam instead of throwing', async () => {
    const handler = createDiscussionStartHandler({ discussions: undefined });
    const out = await handler({ with_agent: 'accounting', topic: 'T' });
    assert.match(out, /not available on this deployment/);
  });

  it('hands a kernel refusal to the model as prose it can relay', async () => {
    const handler = createDiscussionStartHandler({
      discussions: {
        startHere: async () => {
          const err = new Error(
            "agent 'accounting' has no provisioned teams identity — it would have to speak through another bot's name, so the discussion is refused",
          );
          err.name = 'DiscussionAgentHasNoIdentityError';
          throw err;
        },
      },
    });
    const out = await handler({ with_agent: 'accounting', topic: 'T' });
    assert.match(out, /^Error: agent 'accounting' has no provisioned teams identity/);
  });
});
