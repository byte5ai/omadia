import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ambientTurnFrom,
  createDiscussionsCapability,
  DiscussionNoConversationError,
  DiscussionUnknownOpenerError,
  DiscussionUnknownPartnerError,
} from '../src/conductor/discussionHere.js';
import type { DiscussionPartner } from '../src/conductor/discussionHere.js';
import {
  createDiscussionPartnersHandler,
  createDiscussionStartHandler,
  discussionPartnersToolSpec,
  discussionStartToolSpec,
} from '@omadia/plugin-discussion';
import type { DiscussionsCapability } from '@omadia/plugin-discussion';

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

const PARTNERS: DiscussionPartner[] = [
  { slug: 'hr', name: 'Karen' },
  { slug: 'accounting', name: 'FiBu' },
  { slug: 'messias', name: 'Messias' },
];

function capabilityHarness(
  over: { turn?: unknown; opener?: string | undefined; partners?: DiscussionPartner[] } = {},
) {
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
      'turn' in over
        ? (over.turn as never)
        : { channelType: 'teams', conversationId: '19:chat@thread.v2', botChannelKey: HR_BOT },
    resolveOpener: () => ('opener' in over ? over.opener : 'hr'),
    listPartners: async () => over.partners ?? PARTNERS,
  });
  return { capability, started };
}

describe('conductorDiscussions.startHere', () => {
  it('derives conversation AND opener from the turn — the caller supplies neither', async () => {
    const { capability, started } = capabilityHarness();
    const handle = await capability.startHere({ partners: ['accounting'], topic: 'Weiterbildungsbudgets' });
    assert.equal(handle.runId, 'run-1');
    assert.deepEqual(started[0], {
      channelType: 'teams',
      conversationId: '19:chat@thread.v2',
      // The opener first, then the resolved partners — the cast in speaking order.
      participants: ['hr', 'accounting'],
      topic: 'Weiterbildungsbudgets',
    });
  });

  it('accepts the name people SEE in the chat and passes the resolved slug on', async () => {
    const { capability, started } = capabilityHarness();
    await capability.startHere({ partners: ['Messias'], topic: 'T' });
    assert.equal((started[0] as { participants: string[] }).participants[1], 'messias');
  });

  it('matches case- and whitespace-insensitively', async () => {
    const { capability, started } = capabilityHarness();
    await capability.startHere({ partners: ['  FIBU '], topic: 'T' });
    assert.equal((started[0] as { participants: string[] }).participants[1], 'accounting');
  });

  it('refuses an unknown partner WITH the real candidates attached', async () => {
    const { capability, started } = capabilityHarness();
    await assert.rejects(
      () => capability.startHere({ partners: ['nonexistent'], topic: 'T' }),
      (err: Error) => {
        assert.equal(err.name, 'DiscussionUnknownPartnerError');
        const candidates = (err as DiscussionUnknownPartnerError).candidates.map((c) => c.slug);
        // The opener is not a candidate for talking to itself.
        assert.deepEqual(candidates, ['accounting', 'messias']);
        return true;
      },
    );
    assert.deepEqual(started, [], 'nothing may start on a guessed partner');
  });

  it('refuses a partner whose bot is not in this chat', async () => {
    const { capability } = capabilityHarness({ partners: [{ slug: 'hr', name: 'Karen' }] });
    await assert.rejects(
      () => capability.startHere({ partners: ['accounting'], topic: 'T' }),
      DiscussionUnknownPartnerError,
    );
  });

  it('lists the partners here, excluding the agent that was addressed', async () => {
    const { capability } = capabilityHarness();
    assert.deepEqual(await capability.partnersHere(), [
      { slug: 'accounting', name: 'FiBu' },
      { slug: 'messias', name: 'Messias' },
    ]);
  });

  it('passes an explicit guiding question through', async () => {
    const { capability, started } = capabilityHarness();
    await capability.startHere({ partners: ['accounting'], topic: 'T', guidingQuestion: 'Wer zahlt?' });
    assert.equal((started[0] as { guidingQuestion?: string }).guidingQuestion, 'Wer zahlt?');
  });

  it('refuses outside a channel turn — no conversation to start in', async () => {
    const { capability, started } = capabilityHarness({ turn: undefined });
    await assert.rejects(
      () => capability.startHere({ partners: ['accounting'], topic: 'T' }),
      DiscussionNoConversationError,
    );
    assert.deepEqual(started, []);
  });

  it('refuses when the receiving bot maps to no agent — the opener decides whose name appears', async () => {
    const { capability, started } = capabilityHarness({ opener: undefined });
    await assert.rejects(
      () => capability.startHere({ partners: ['accounting'], topic: 'T' }),
      DiscussionUnknownOpenerError,
    );
    assert.deepEqual(started, []);
  });

  it('refuses when the turn carries no bot identity at all', async () => {
    const { capability } = capabilityHarness({
      turn: { channelType: 'teams', conversationId: '19:chat@thread.v2' },
    });
    await assert.rejects(
      () => capability.startHere({ partners: ['accounting'], topic: 'T' }),
      DiscussionUnknownOpenerError,
    );
  });
});

// --- the tools the model actually calls ------------------------------------

function fakeCapability(over: Partial<DiscussionsCapability> = {}): DiscussionsCapability {
  return {
    startHere: async () => ({
      runId: 'run-1',
      workflowSlug: 'eph-discussion-abc',
      expiresAt: '1970-01-01T00:00:00.000Z',
    }),
    partnersHere: async () => PARTNERS,
    ...over,
  };
}

describe('discussion_start tool', () => {
  it('exposes with_agent + topic as the only required inputs', () => {
    assert.deepEqual(discussionStartToolSpec.input_schema.required, ['with_agents', 'topic']);
    const props = Object.keys(discussionStartToolSpec.input_schema.properties).sort();
    assert.deepEqual(props, ['guiding_question', 'max_turns', 'topic', 'with_agents']);
    // No conversation and no opener on the model-facing surface.
    assert.equal(props.includes('conversation_id'), false);
    assert.equal(props.includes('as_agent'), false);
  });

  it('starts the discussion and tells the model to stop talking', async () => {
    const calls: unknown[] = [];
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async (input) => {
            calls.push(input);
            return { runId: 'run-1', workflowSlug: 'eph-discussion-abc', expiresAt: '1970-01-01T00:00:00.000Z' };
          },
        }),
    });
    const out = await handler({ with_agents: ['accounting'], topic: 'Weiterbildungsbudgets' });
    const parsed = JSON.parse(out) as { started: boolean; with_agents: string[]; note: string };
    assert.equal(parsed.started, true);
    assert.deepEqual(parsed.with_agents, ['accounting']);
    assert.match(parsed.note, /do not repeat the topic/i);
    assert.deepEqual(calls, [{ partners: ['accounting'], topic: 'Weiterbildungsbudgets' }]);
  });

  it('opens a THREE-way round in ONE call', async () => {
    // The live attempt failed here: the agent reported it could couple "immer
    // nur einen Partner pro Aufruf" and offered to add the third in a separate
    // turn. One call, every partner named.
    const calls: unknown[] = [];
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async (input) => {
            calls.push(input);
            return { runId: 'run-1', workflowSlug: 'eph-discussion-abc', expiresAt: '1970-01-01T00:00:00.000Z' };
          },
        }),
    });
    const out = await handler({ with_agents: ['accounting', 'Messias'], topic: 'T' });
    assert.equal((JSON.parse(out) as { started: boolean }).started, true);
    assert.deepEqual((calls[0] as { partners: string[] }).partners, ['accounting', 'Messias']);
  });

  it('accepts a single name, and the older with_agent spelling', async () => {
    const calls: unknown[] = [];
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async (input) => {
            calls.push(input);
            return { runId: 'r', workflowSlug: 's', expiresAt: '1970-01-01T00:00:00.000Z' };
          },
        }),
    });
    await handler({ with_agents: 'accounting', topic: 'T' });
    assert.deepEqual((calls[0] as { partners: string[] }).partners, ['accounting']);
    await handler({ with_agent: 'clippy', topic: 'T' });
    assert.deepEqual((calls[1] as { partners: string[] }).partners, ['clippy']);
  });

  it('passes an explicit turn ceiling through', async () => {
    const calls: unknown[] = [];
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async (input) => {
            calls.push(input);
            return { runId: 'r', workflowSlug: 's', expiresAt: '1970-01-01T00:00:00.000Z' };
          },
        }),
    });
    await handler({ with_agents: ['accounting'], topic: 'T', max_turns: 30 });
    assert.equal((calls[0] as { maxTurns?: number }).maxTurns, 30);
  });

  it('RESOLVES THE CAPABILITY PER CALL — one absent at activation must not freeze', async () => {
    // The live failure: `optional_requires` creates no activation edge, so the
    // capability was undefined when the plugin activated and the tool answered
    // "not available" for the process's whole life. It must recover the moment
    // the kernel publishes it.
    let published: DiscussionsCapability | undefined;
    const handler = createDiscussionStartHandler({ resolveDiscussions: () => published });

    const before = await handler({ with_agents: ['accounting'], topic: 'T' });
    assert.match(before, /not available on this deployment/);

    published = fakeCapability();
    const after = await handler({ with_agents: ['accounting'], topic: 'T' });
    assert.equal((JSON.parse(after) as { started: boolean }).started, true);
  });

  it('answers an unknown partner WITH the candidate list so the model can retry', async () => {
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async () => {
            throw new DiscussionUnknownPartnerError('messias', PARTNERS);
          },
        }),
    });
    const out = await handler({ with_agents: ['messias'], topic: 'T' });
    assert.match(out, /^Error: /);
    assert.match(out, /Available in this chat/);
    assert.match(out, /messias \(Messias\)/);
  });

  it('rejects a malformed agent slug before reaching the kernel', async () => {
    const handler = createDiscussionStartHandler({
      resolveDiscussions: () =>
        fakeCapability({
          startHere: async () => assert.fail('must not reach the kernel'),
        }),
    });
    assert.match(await handler({ with_agents: [''], topic: 'T' }), /^Error: /);
  });

  it('requires a topic', async () => {
    const handler = createDiscussionStartHandler({ resolveDiscussions: () => undefined });
    assert.match(await handler({ with_agents: ['accounting'] }), /^Error: /);
  });

  it('explains a missing kernel seam instead of throwing', async () => {
    const handler = createDiscussionStartHandler({ resolveDiscussions: () => undefined });
    assert.match(await handler({ with_agents: ['accounting'], topic: 'T' }), /not available on this deployment/);
  });
});

describe('discussion_partners tool', () => {
  it('takes no arguments and returns slug + the name people see', async () => {
    assert.deepEqual(discussionPartnersToolSpec.input_schema.required, []);
    const handler = createDiscussionPartnersHandler({ resolveDiscussions: () => fakeCapability() });
    const parsed = JSON.parse(await handler({})) as { partners: DiscussionPartner[]; note: string };
    assert.deepEqual(parsed.partners, PARTNERS);
    assert.match(parsed.note, /slug/);
  });

  it('says plainly when nobody else can be heard here', async () => {
    const handler = createDiscussionPartnersHandler({
      resolveDiscussions: () => fakeCapability({ partnersHere: async () => [] }),
    });
    const parsed = JSON.parse(await handler({})) as { partners: unknown[]; note: string };
    assert.deepEqual(parsed.partners, []);
    assert.match(parsed.note, /no discussion can be held here/i);
  });

  it('resolves the capability per call, like the start tool', async () => {
    let published: DiscussionsCapability | undefined;
    const handler = createDiscussionPartnersHandler({ resolveDiscussions: () => published });
    assert.match(await handler({}), /not available on this deployment/);
    published = fakeCapability();
    assert.match(await handler({}), /"partners"/);
  });
});
