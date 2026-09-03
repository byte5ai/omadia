import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { applyTemplateSlots, checkTemplateManifest, extractSlotRefs, validate, validateGraphShape } from '@omadia/conductor-core';
import type { TemplateManifest, WorkflowGraph } from '@omadia/conductor-core';

import { ConductorSayService, formatUtterance, stripFencedJson } from '../src/conductor/sayService.js';
import type { EphemeralAttachment } from '../src/conductor/ephemeralAttachmentsStore.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';

// `Step.say` — the agent-dialogue primitive. Without it an agent step's answer
// never leaves the run context, which is one of the three reasons two agent
// bots could not hold a topic conversation in Teams.

const agentStep = (extra: Record<string, unknown> = {}) => ({
  id: 'a',
  kind: 'agent' as const,
  agentId: 'hr',
  prompt: 'p',
  ...extra,
});

describe('graph shape — say', () => {
  const graphWith = (step: unknown): unknown => ({
    entryStepId: 'a',
    steps: [step],
    transitions: [],
  });

  it('accepts a well-formed say on an agent step', () => {
    const result = validateGraphShape(graphWith(agentStep({ say: { channel: 'teams', speaker: 'HR' } })));
    assert.equal(result.ok, true, result.errors.join('; '));
  });

  it('accepts say without the optional speaker', () => {
    assert.equal(validateGraphShape(graphWith(agentStep({ say: { channel: 'teams' } }))).ok, true);
  });

  it('rejects say without a channel', () => {
    assert.equal(validateGraphShape(graphWith(agentStep({ say: {} }))).ok, false);
  });

  it('rejects a non-string channel', () => {
    assert.equal(validateGraphShape(graphWith(agentStep({ say: { channel: 7 } }))).ok, false);
  });

  it('rejects an unknown say property', () => {
    assert.equal(validateGraphShape(graphWith(agentStep({ say: { channel: 'teams', shout: true } }))).ok, false);
  });
});

describe('validate — say belongs to agent steps', () => {
  it('accepts say on an agent step', () => {
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'agent', agentId: 'hr', prompt: 'p', say: { channel: 'teams' } }],
      transitions: [],
    };
    assert.deepEqual(validate(graph).errors, []);
  });

  it('rejects say on an action step — an action has no answer to publish', () => {
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'action', actionId: 'tool', say: { channel: 'teams' } }],
      transitions: [],
    };
    const codes = validate(graph).errors.map((e) => e.code);
    assert.ok(codes.includes('say_requires_agent_step'), codes.join(', '));
  });
});

describe('template slots — say.channel', () => {
  const manifest = (): TemplateManifest =>
    ({
      id: 'demo',
      name: { en: 'demo' },
      description: { en: 'demo' },
      graph: {
        entryStepId: 'a',
        steps: [{ id: 'a', kind: 'agent', agentId: 'slot:agent:a', prompt: 'p', say: { channel: 'slot:channel:room' } }],
        transitions: [],
      },
      slots: {
        agents: [{ key: 'a', label: { en: 'A' } }],
        channels: [{ key: 'room', label: { en: 'Room' } }],
      },
    }) as unknown as TemplateManifest;

  it('finds the channel placeholder inside say', () => {
    const refs = extractSlotRefs(manifest().graph);
    assert.ok(refs.some((r) => r.kind === 'channels' && r.key === 'room'), JSON.stringify(refs));
  });

  it('substitutes the mapped channel into say', () => {
    const graph = applyTemplateSlots(manifest(), { agents: { a: 'hr' }, channels: { room: 'teams' } });
    assert.equal(graph.steps[0]?.say?.channel, 'teams');
  });

  it('flags an undeclared channel slot used only inside say', () => {
    const broken = manifest();
    broken.slots = { agents: [{ key: 'a', label: { en: 'A' } }] } as TemplateManifest['slots'];
    const codes = checkTemplateManifest(broken).errors.map((e) => e.code);
    assert.ok(codes.includes('template_undeclared_slot'), codes.join(', '));
  });
});

describe('utterance formatting', () => {
  it('strips the fenced verdict block — guard fuel is not conversation', () => {
    const text = 'Mein Punkt steht.\n\n```json\n{"converged": false}\n```';
    assert.equal(stripFencedJson(text), 'Mein Punkt steht.');
  });

  it('prefixes the speaker name', () => {
    assert.equal(formatUtterance('HR', 'Moin'), '**HR:** Moin');
  });

  it('falls back to the bare text when there is no speaker name', () => {
    assert.equal(formatUtterance('  ', 'Moin'), 'Moin');
  });
});

// --- say service -----------------------------------------------------------

const attachment = (over: Partial<EphemeralAttachment> = {}): EphemeralAttachment => ({
  id: 'att-1',
  workflowId: 'wf-1',
  agentSlug: 'hr',
  channelType: 'teams',
  channelKey: 'conv-1',
  roleKey: null,
  state: 'attached',
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

function harness(over: { attachment?: EphemeralAttachment | undefined; provider?: unknown } = {}) {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const provider = {
    channelType: 'teams',
    async sendToConversation(conversationId: string, message: { text: string }) {
      sent.push({ conversationId, text: message.text });
      return { outcome: 'delivered' as const };
    },
  };
  const service = new ConductorSayService({
    attachments: { getByConversation: async () => over.attachment },
    providers: { get: () => (over.provider === undefined ? provider : (over.provider as typeof provider)) },
  });
  return { service, sent };
}

const input = {
  workflowId: 'wf-1',
  runId: 'run-1',
  agentSlug: 'hr',
  speaker: 'HR',
  channelType: 'teams',
  conversationId: 'conv-1',
  text: 'Mein Beitrag.',
};

describe('ConductorSayService — the floor is derived from the RUN', () => {
  it('delivers when the conversation is attached to this run’s workflow', async () => {
    const { service, sent } = harness({ attachment: attachment() });
    assert.deepEqual(await service.say(input), { said: true });
    assert.deepEqual(sent, [{ conversationId: 'conv-1', text: '**HR:** Mein Beitrag.' }]);
  });

  it('delivers on a still-pending attachment — createEphemeralRun starts before it can attach', async () => {
    const { service } = harness({ attachment: attachment({ workflowId: null, state: 'pending' }) });
    assert.deepEqual(await service.say(input), { said: true });
  });

  it('refuses when the conversation belongs to ANOTHER workflow', async () => {
    const { service, sent } = harness({ attachment: attachment({ workflowId: 'wf-other' }) });
    const outcome = await service.say(input);
    assert.equal(outcome.said, false);
    assert.equal(outcome.said === false && outcome.reason, 'foreign_workflow');
    assert.deepEqual(sent, []);
  });

  it('refuses when no attachment binds the conversation — fail closed', async () => {
    const { service, sent } = harness({ attachment: undefined });
    const outcome = await service.say(input);
    assert.equal(outcome.said === false && outcome.reason, 'no_attachment');
    assert.deepEqual(sent, []);
  });

  it('refuses a rehearsal — a preview/dry-run turn carries no workflow and never posts', async () => {
    const { service, sent } = harness({ attachment: attachment({ workflowId: null, state: 'pending' }) });
    const outcome = await service.say({ ...input, workflowId: null });
    assert.equal(outcome.said === false && outcome.reason, 'no_workflow');
    assert.deepEqual(sent, []);
  });

  it('refuses without a conversation id', async () => {
    const { service } = harness({ attachment: attachment() });
    const outcome = await service.say({ ...input, conversationId: '  ' });
    assert.equal(outcome.said === false && outcome.reason, 'no_conversation');
  });

  it('refuses when the answer is only a verdict block', async () => {
    const { service } = harness({ attachment: attachment() });
    const outcome = await service.say({ ...input, text: '```json\n{"converged":true}\n```' });
    assert.equal(outcome.said === false && outcome.reason, 'empty_text');
  });

  it('names a missing provider instead of throwing', async () => {
    const { service } = harness({ attachment: attachment(), provider: undefined as never });
    const noProvider = new ConductorSayService({
      attachments: { getByConversation: async () => attachment() },
      providers: { get: () => undefined },
    });
    void service;
    const outcome = await noProvider.say(input);
    assert.equal(outcome.said === false && outcome.reason, 'no_provider');
  });

  it('turns a throwing provider into a named outcome, never an exception', async () => {
    const service = new ConductorSayService({
      attachments: { getByConversation: async () => attachment() },
      providers: {
        get: () => ({
          channelType: 'teams',
          sendToConversation: async () => {
            throw new Error('teams is down');
          },
        }),
      },
    });
    const outcome = await service.say(input);
    assert.equal(outcome.said === false && outcome.reason, 'channel_error');
  });

  it('defaults the speaker to the agent slug', async () => {
    const { service, sent } = harness({ attachment: attachment() });
    await service.say({ ...input, speaker: '', agentSlug: 'accounting' });
    assert.equal(sent[0]?.text.startsWith('**accounting:**'), true, sent[0]?.text ?? 'nothing sent');
  });
});

// --- effects wiring --------------------------------------------------------

function effectsHarness(sayResult: Awaited<ReturnType<ConductorSayService['say']>>) {
  const calls: unknown[] = [];
  const effects = new RealStepEffects({
    getRegistry: () =>
      ({
        get: () => ({
          built: {
            bundle: {
              agent: {
                chat: async () => ({ text: 'Mein Beitrag.\n\n```json\n{"converged": false}\n```' }),
              },
            },
          },
        }),
      }) as never,
    say: {
      say: async (payload: unknown) => {
        calls.push(payload);
        return sayResult;
      },
    } as never,
  });
  return { effects, calls };
}

describe('RealStepEffects — say wiring', () => {
  it('publishes exactly when the step carries say, and records the outcome', async () => {
    const { effects, calls } = effectsHarness({ said: true });
    const exec = await effects.runAgentStep(
      { id: 'speak-a', kind: 'agent', agentId: 'hr', prompt: 'p', say: { channel: 'teams', speaker: 'HR' } },
      { conversationId: 'conv-1' },
      { runId: 'run-1', workflowId: 'wf-1' },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as Record<string, unknown>).speaker, 'HR');
    assert.equal((exec.result as Record<string, unknown>).said, true);
  });

  it('does NOT publish for an ordinary agent step', async () => {
    const { effects, calls } = effectsHarness({ said: true });
    const exec = await effects.runAgentStep(
      { id: 'plain', kind: 'agent', agentId: 'hr', prompt: 'p' },
      {},
      { runId: 'run-1', workflowId: 'wf-1' },
    );
    assert.deepEqual(calls, []);
    assert.equal('said' in (exec.result as Record<string, unknown>), false);
  });

  it('records an undelivered turn as said:false rather than failing the run', async () => {
    const { effects } = effectsHarness({ said: false, reason: 'no_attachment', message: 'nope' });
    const exec = await effects.runAgentStep(
      { id: 'speak-a', kind: 'agent', agentId: 'hr', prompt: 'p', say: { channel: 'teams' } },
      { conversationId: 'conv-1' },
      { runId: 'run-1', workflowId: 'wf-1' },
    );
    const result = exec.result as Record<string, unknown>;
    assert.equal(result.said, false);
    assert.equal(result.sayError, 'no_attachment');
  });
});
