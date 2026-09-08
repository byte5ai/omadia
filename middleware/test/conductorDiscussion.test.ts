import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { applyTemplateSlots, checkTemplateManifest, missingSlotMappings, validate } from '@omadia/conductor-core';
import type { JsonObject, Step } from '@omadia/conductor-core';

import { loadPatternCatalog } from '../src/conductor/patternCatalog.js';
import {
  advanceSpeaker,
  appendTranscript,
  renderTranscript,
  TRANSCRIPT_MAX_ENTRIES,
  TRANSCRIPT_TEXT_MAX_CHARS,
} from '../src/conductor/transcript.js';
import type { TranscriptEntry } from '../src/conductor/transcript.js';
import {
  ConductorDiscussionService,
  DiscussionConversationBusyError,
  DiscussionInvalidInputError,
  DISCUSSION_PATTERN_ID,
} from '../src/conductor/discussionService.js';
import type { EphemeralAttachment } from '../src/conductor/ephemeralAttachmentsStore.js';

// The topic conversation between two agents: pattern, shared transcript, and
// the service that gives the run its conversation floor.

const sayStep = (over: Partial<Step> = {}): Step => ({
  id: 'speak-a',
  kind: 'agent',
  agentId: 'hr',
  say: { channel: 'teams', speaker: 'HR' },
  ...over,
});

describe('run transcript — the bus a Teams bot cannot be', () => {
  it('appends a say step’s utterance', () => {
    const ctx = appendTranscript({}, sayStep(), { text: 'Moin.' });
    const transcript = ctx.transcript as TranscriptEntry[];
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.speaker, 'HR');
    assert.equal(transcript[0]?.text, 'Moin.');
    assert.equal(transcript[0]?.agent, 'hr');
  });

  it('renders the speaker lines in order', () => {
    let ctx: JsonObject = appendTranscript({}, sayStep(), { text: 'Erste.' });
    ctx = appendTranscript(ctx, sayStep({ id: 'speak-b', agentId: 'acc', say: { channel: 'teams', speaker: 'FiBu' } }), {
      text: 'Zweite.',
    });
    assert.equal(ctx.transcriptText, 'HR: Erste.\n\nFiBu: Zweite.');
  });

  it('strips the fenced verdict from the transcript too', () => {
    const ctx = appendTranscript({}, sayStep(), { text: 'Sichtbar.\n```json\n{"converged":false}\n```' });
    assert.equal((ctx.transcript as TranscriptEntry[])[0]?.text, 'Sichtbar.');
  });

  it('ignores a step without say — internal steps stay out of the shared floor', () => {
    const ctx = appendTranscript({}, { id: 'x', kind: 'agent', agentId: 'hr' }, { text: 'intern' });
    assert.equal('transcript' in ctx, false);
  });

  it('ignores an empty answer', () => {
    const ctx = appendTranscript({}, sayStep(), { text: '   ' });
    assert.equal('transcript' in ctx, false);
  });

  it('keeps the utterance even when delivery failed — the chat is the projection', () => {
    const ctx = appendTranscript({}, sayStep(), { text: 'Trotzdem gesagt.', said: false, sayError: 'channel_error' });
    assert.equal((ctx.transcript as TranscriptEntry[]).length, 1);
  });

  it('caps the entry count, dropping the oldest', () => {
    let ctx: JsonObject = {};
    for (let i = 0; i < TRANSCRIPT_MAX_ENTRIES + 5; i += 1) {
      ctx = appendTranscript(ctx, sayStep(), { text: `Beitrag ${String(i)}.` });
    }
    const transcript = ctx.transcript as TranscriptEntry[];
    assert.equal(transcript.length, TRANSCRIPT_MAX_ENTRIES);
    assert.equal(transcript[0]?.text, `Beitrag 5.`);
  });

  it('caps the rendered text, keeping the most recent turns', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 30 }, (_, i) => ({
      step: 'speak-a',
      agent: 'hr',
      speaker: 'HR',
      text: 'x'.repeat(1000),
      at: new Date(0).toISOString(),
      [`_${String(i)}`]: i,
    })) as TranscriptEntry[];
    const rendered = renderTranscript(entries);
    assert.ok(rendered.length <= TRANSCRIPT_TEXT_MAX_CHARS, String(rendered.length));
  });
});

describe('the floor rotates through the cast', () => {
  it('hands the floor on after each utterance, wrapping round', () => {
    const cast = { participants: ['hr', 'accounting', 'clippy'], speaker: 'hr' };
    const a = advanceSpeaker(cast);
    assert.equal(a.speaker, 'accounting');
    assert.equal(advanceSpeaker(a).speaker, 'clippy');
    assert.equal(advanceSpeaker(advanceSpeaker(a)).speaker, 'hr');
  });

  it('rotates as part of appending an utterance — one step serves every voice', () => {
    const ctx = appendTranscript(
      { participants: ['hr', 'accounting'], speaker: 'hr' },
      sayStep(),
      { text: 'Moin.' },
    );
    assert.equal(ctx.speaker, 'accounting');
  });

  it('leaves a single-voice workflow alone', () => {
    assert.deepEqual(advanceSpeaker({ speaker: 'hr' }), { speaker: 'hr' });
  });

  it('restarts at the top when the current speaker is not in the cast', () => {
    assert.equal(advanceSpeaker({ participants: ['hr', 'accounting'], speaker: 'ghost' }).speaker, 'hr');
  });

  it('ignores non-string entries rather than handing the floor to nothing', () => {
    const out = advanceSpeaker({ participants: ['hr', 42, '', 'clippy'], speaker: 'hr' } as never);
    assert.equal(out.speaker, 'clippy');
  });
});

describe('discussion pattern', () => {
  const catalog = loadPatternCatalog();
  const pattern = catalog.get(DISCUSSION_PATTERN_ID);

  it('ships in the curated catalog', () => {
    assert.ok(pattern, 'discussion pattern missing from the catalog');
  });

  it('is a valid template manifest', () => {
    assert.deepEqual(checkTemplateManifest(pattern!).errors, []);
  });

  it('declares NO agent slot — the cast comes from the run, not the graph', () => {
    // An agent slot per participant would freeze the roster at authoring time,
    // which is what limited the first cut to exactly two voices.
    assert.equal((pattern!.slots.agents ?? []).length, 0);
    assert.deepEqual((pattern!.slots.channels ?? []).map((s) => s.key), ['discussion']);
  });

  it('needs only the channel mapped', () => {
    const missing = missingSlotMappings(pattern!, {}).map((m) => `${m.kind}:${m.key}`);
    assert.deepEqual(missing, ['channels:discussion']);
  });

  it('produces a valid graph once the channel is filled — no unguarded cycle', () => {
    const graph = applyTemplateSlots(pattern!, { channels: { discussion: 'teams' } });
    assert.deepEqual(validate(graph).errors, []);
  });

  it('validates even with known-agent refs supplied — the speaker is a run value', () => {
    const graph = applyTemplateSlots(pattern!, { channels: { discussion: 'teams' } });
    // `{{ctx.speaker}}` is not an agent id and must not be checked as one.
    assert.deepEqual(validate(graph, { agentIds: ['hr', 'accounting'] }).errors, []);
  });

  it('rotates ONE speak step rather than one step per participant', () => {
    const graph = applyTemplateSlots(pattern!, { channels: { discussion: 'teams' } });
    assert.deepEqual(graph.steps.map((s) => s.id).sort(), ['close', 'speak']);
    assert.equal(graph.steps.find((s) => s.id === 'speak')?.agentId, '{{ctx.speaker}}');
    assert.equal(graph.steps.find((s) => s.id === 'close')?.agentId, '{{ctx.closer}}');
  });

  it('publishes every turn: each agent step carries say', () => {
    const graph = applyTemplateSlots(pattern!, { channels: { discussion: 'teams' } });
    for (const step of graph.steps) {
      assert.equal(step.say?.channel, 'teams', `step '${step.id}' does not publish`);
    }
  });

  it('bounds the loop on a CALLER-supplied ceiling, not a literal', () => {
    const loop = pattern!.graph.transitions.find((t) => t.source === 'speak' && t.target === 'speak');
    assert.ok(loop?.guard, 'the self-loop must be guarded');
    const serialized = JSON.stringify(loop!.guard);
    assert.ok(serialized.includes('ctx.stepAttempts.speak'), serialized);
    // The ceiling is a path into the run context — a literal here is what
    // capped every discussion at seven regardless of whether it was improving.
    assert.ok(serialized.includes('"valuePath":"ctx.maxTurns"'), serialized);
  });

  it('ends on declared convergence, and falls back to the closing summary', () => {
    const loop = pattern!.graph.transitions.find((t) => t.source === 'speak' && t.target === 'speak');
    assert.ok(JSON.stringify(loop!.guard).includes('converged'));
    const speak = pattern!.graph.steps.find((s) => s.id === 'speak');
    const fallback = pattern!.graph.transitions.find((t) => t.id === speak!.fallbackTransitionId);
    assert.equal(fallback?.target, 'close');
  });
});

// --- discussion service ----------------------------------------------------

const IDENTITIES: Record<string, string> = {
  hr: '28:aaaaaaaa-1111-2222-3333-444444444444',
  accounting: '28:bbbbbbbb-5555-6666-7777-888888888888',
};

function serviceHarness(existing?: EphemeralAttachment, identities: Record<string, string> = IDENTITIES) {
  const created: unknown[] = [];
  const attached: unknown[] = [];
  const pending: unknown[] = [];
  const service = new ConductorDiscussionService({
    identityFor: (slug) => (identities[slug] ? { channelKey: identities[slug] } : undefined),
    ephemeralRuns: {
      createEphemeralRun: async (input: unknown) => {
        created.push(input);
        return {
          runId: 'run-1',
          workflowId: 'wf-1',
          workflowSlug: 'eph-discussion-abc',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    } as never,
    attachments: {
      getByConversation: async () => existing,
      upsertPending: async (input: unknown) => {
        pending.push(input);
        return {} as EphemeralAttachment;
      },
      attachToWorkflow: async (input: unknown) => {
        attached.push(input);
        return undefined;
      },
    } as never,
  });
  return { service, created, attached, pending };
}

const start = {
  channelType: 'teams',
  conversationId: 'conv-1',
  participants: ['hr', 'accounting'],
  topic: 'Wie verbuchen wir Weiterbildungsbudgets?',
};

describe('ConductorDiscussionService', () => {
  it('claims the floor, then starts the run with both agents and the conversation in context', async () => {
    const { service, created, attached, pending } = serviceHarness();
    const handle = await service.start(start);
    assert.equal(handle.runId, 'run-1');
    assert.equal(pending.length, 1);
    const input = created[0] as {
      patternId: string;
      slots: Record<string, Record<string, string>>;
      payload: Record<string, unknown>;
    };
    assert.equal(input.patternId, DISCUSSION_PATTERN_ID);
    assert.deepEqual(input.slots.channels, { discussion: 'teams' });
    assert.equal(input.payload.conversationId, 'conv-1');
    assert.equal(input.payload.topic, start.topic);
    // guidingQuestion defaults to the topic rather than going empty.
    assert.equal(input.payload.guidingQuestion, start.topic);
    // The cast, who holds the floor, who closes, and the ceiling.
    assert.deepEqual(input.payload.participants, ['hr', 'accounting']);
    assert.equal(input.payload.speaker, 'hr');
    assert.equal(input.payload.closer, 'hr');
    assert.equal(input.payload.maxTurns, 16);
    assert.equal(attached.length, 1);
  });

  it('refuses a conversation already attached to another workflow', async () => {
    const { service, created } = serviceHarness({
      id: 'a',
      workflowId: 'wf-other',
      agentSlug: 'facilitator',
      channelType: 'teams',
      channelKey: 'conv-1',
      roleKey: null,
      state: 'attached',
      expiresAt: new Date(),
    });
    await assert.rejects(() => service.start(start), DiscussionConversationBusyError);
    assert.deepEqual(created, []);
  });

  it('REFUSES to start when a participant has no bot of its own', async () => {
    const { service, created, pending } = serviceHarness(undefined, { hr: IDENTITIES.hr! });
    await assert.rejects(() => service.start(start), (err: Error) => {
      assert.equal(err.name, 'DiscussionAgentHasNoIdentityError');
      assert.match(err.message, /accounting/);
      return true;
    });
    // Refused BEFORE any side effect: no floor claimed, no run started.
    assert.deepEqual(pending, []);
    assert.deepEqual(created, []);
  });

  it('refuses when neither participant has a bot', async () => {
    const { service } = serviceHarness(undefined, {});
    await assert.rejects(() => service.start(start), (err: Error) => {
      assert.equal(err.name, 'DiscussionAgentHasNoIdentityError');
      assert.match(err.message, /'hr'/);
      return true;
    });
  });

  it('de-duplicates a repeated agent and then refuses the single voice left', async () => {
    const { service } = serviceHarness();
    await assert.rejects(
      () => service.start({ ...start, participants: ['hr', 'hr'] }),
      DiscussionInvalidInputError,
    );
  });

  it('carries three participants through in speaking order', async () => {
    const { service, created } = serviceHarness(undefined, {
      hr: IDENTITIES.hr!,
      accounting: IDENTITIES.accounting!,
      clippy: '28:cccccccc-9999-0000-1111-222222222222',
    });
    await service.start({ ...start, participants: ['hr', 'accounting', 'clippy'] });
    const payload = (created[0] as { payload: Record<string, unknown> }).payload;
    assert.deepEqual(payload.participants, ['hr', 'accounting', 'clippy']);
  });

  it('clamps the turn ceiling instead of trusting the caller', async () => {
    const { service, created } = serviceHarness();
    await service.start({ ...start, maxTurns: 5000 });
    assert.equal((created[0] as { payload: Record<string, unknown> }).payload.maxTurns, 40);
    created.length = 0;
    await service.start({ ...start, maxTurns: 1 });
    assert.equal((created[0] as { payload: Record<string, unknown> }).payload.maxTurns, 2);
  });

  it('refuses missing input', async () => {
    const { service } = serviceHarness();
    await assert.rejects(() => service.start({ ...start, topic: '   ' }), DiscussionInvalidInputError);
    await assert.rejects(() => service.start({ ...start, conversationId: '' }), DiscussionInvalidInputError);
  });
});
