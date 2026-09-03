import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { applyTemplateSlots, checkTemplateManifest, missingSlotMappings, validate } from '@omadia/conductor-core';
import type { JsonObject, Step } from '@omadia/conductor-core';

import { loadPatternCatalog } from '../src/conductor/patternCatalog.js';
import {
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

describe('discussion pattern', () => {
  const catalog = loadPatternCatalog();
  const pattern = catalog.get(DISCUSSION_PATTERN_ID);

  it('ships in the curated catalog', () => {
    assert.ok(pattern, 'discussion pattern missing from the catalog');
  });

  it('is a valid template manifest', () => {
    assert.deepEqual(checkTemplateManifest(pattern!).errors, []);
  });

  it('declares two agent slots and a channel slot', () => {
    const agents = (pattern!.slots.agents ?? []).map((s) => s.key).sort();
    assert.deepEqual(agents, ['a', 'b']);
    assert.deepEqual((pattern!.slots.channels ?? []).map((s) => s.key), ['discussion']);
  });

  it('reports both agents and the channel as required slots when unmapped', () => {
    const missing = missingSlotMappings(pattern!, {}).map((m) => `${m.kind}:${m.key}`).sort();
    assert.deepEqual(missing, ['agents:a', 'agents:b', 'channels:discussion']);
  });

  it('produces a valid graph once the slots are filled — no unguarded cycle', () => {
    const graph = applyTemplateSlots(pattern!, {
      agents: { a: 'hr', b: 'accounting' },
      channels: { discussion: 'teams' },
    });
    assert.deepEqual(validate(graph).errors, []);
  });

  it('publishes every turn: each agent step carries say', () => {
    const graph = applyTemplateSlots(pattern!, {
      agents: { a: 'hr', b: 'accounting' },
      channels: { discussion: 'teams' },
    });
    assert.equal(graph.steps.length, 3);
    for (const step of graph.steps) {
      assert.equal(step.say?.channel, 'teams', `step '${step.id}' does not publish`);
    }
  });

  it('bounds the round cycle on the executor-owned attempt counter', () => {
    const loop = pattern!.graph.transitions.find((t) => t.source === 'speak-b' && t.target === 'speak-a');
    assert.ok(loop?.guard, 'the loop edge back to speak-a must be guarded');
    const serialized = JSON.stringify(loop!.guard);
    assert.ok(serialized.includes('ctx.stepAttempts.speak-a'), serialized);
    assert.ok(/"value":\s*\d+/.test(serialized), serialized);
  });

  it('ends on declared convergence', () => {
    for (const source of ['speak-a', 'speak-b']) {
      const forward = pattern!.graph.transitions.find((t) => t.source === source && t.guard);
      assert.ok(JSON.stringify(forward!.guard).includes('converged'), source);
      const step = pattern!.graph.steps.find((s) => s.id === source);
      const fallback = pattern!.graph.transitions.find((t) => t.id === step!.fallbackTransitionId);
      assert.equal(fallback?.target, 'close', `${source} must fall back to the closing summary`);
    }
  });
});

// --- discussion service ----------------------------------------------------

function serviceHarness(existing?: EphemeralAttachment) {
  const created: unknown[] = [];
  const attached: unknown[] = [];
  const pending: unknown[] = [];
  const service = new ConductorDiscussionService({
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
  agentA: 'hr',
  agentB: 'accounting',
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
      payload: Record<string, string>;
    };
    assert.equal(input.patternId, DISCUSSION_PATTERN_ID);
    assert.deepEqual(input.slots.agents, { a: 'hr', b: 'accounting' });
    assert.deepEqual(input.slots.channels, { discussion: 'teams' });
    assert.equal(input.payload.conversationId, 'conv-1');
    assert.equal(input.payload.topic, start.topic);
    // guidingQuestion defaults to the topic rather than going empty.
    assert.equal(input.payload.guidingQuestion, start.topic);
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

  it('refuses the same agent twice — a discussion needs two voices', async () => {
    const { service } = serviceHarness();
    await assert.rejects(() => service.start({ ...start, agentB: 'hr' }), DiscussionInvalidInputError);
  });

  it('refuses missing input', async () => {
    const { service } = serviceHarness();
    await assert.rejects(() => service.start({ ...start, topic: '   ' }), DiscussionInvalidInputError);
    await assert.rejects(() => service.start({ ...start, conversationId: '' }), DiscussionInvalidInputError);
  });
});
