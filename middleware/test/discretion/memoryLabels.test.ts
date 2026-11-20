/**
 * Spec 2042 §5.11 / §6 criterion 27 — labels persist through memory:
 *
 *  - a memory note keeps the labels of the turn that wrote it (by physical
 *    path) and a later turn that reads it carries them, so its answer to a
 *    wider room and its CRM write are refused;
 *  - a memory write that would carry another conversation's knowledge into a
 *    tier with other readers is refused before anything is written, also
 *    through the real orchestrator's `memory` dispatch;
 *  - a recalled memorable brings the labels it was written with.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import {
  readersOf,
  unionLabels,
  type DiscretionLabel,
  type LabelSet,
} from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionAuditEntry, DiscretionPort, LabelSubjectKind } from '../../packages/harness-orchestrator/src/discretion/port.js';
import {
  createDiscretionTurnState,
  currentTurnLabels,
  peopleEgressDecision,
} from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import { guardIntegrationEgress, guardMemoryEgress } from '../../packages/harness-orchestrator/src/discretion/toolFlow.js';
import { LabelledMemoryStore } from '../../packages/harness-orchestrator/src/discretion/labelledMemoryStore.js';
import { scriptedModel, text, toolCalls } from '../_helpers/replayTurnFixture.js';

const HR_DM = 'teams:dm-hr';
const SALES = 'teams:sales';
const hrReaders = readersOf(['hr-mgr']);
const salesReaders = readersOf(['s1', 's2']);
const hrSource: DiscretionLabel = { kind: 'source', system: '@omadia/odoo-hr', restricted: true };
const hrContext: DiscretionLabel = { kind: 'context', key: HR_DM, readers: hrReaders };

function fakePort(seed: Array<[LabelSubjectKind, string, LabelSet]> = []) {
  const stored = new Map<string, LabelSet>(seed.map(([kind, id, labels]) => [`${kind}|${id}`, labels]));
  const audits: DiscretionAuditEntry[] = [];
  const port: DiscretionPort = {
    declarationOf: async (integration) =>
      integration === '@omadia/crm'
        ? {
            sensitivity: 'internal',
            readership: { readers: { kind: 'everyone' }, acceptsSystems: [], acceptsClassifications: [] },
          }
        : undefined,
    labelsOf: async (kind, ids) =>
      new Map(ids.flatMap((id) => (stored.has(`${kind}|${id}`) ? [[id, stored.get(`${kind}|${id}`)!]] : []))),
    persistLabels: async (kind, id, _agent, labels) => {
      stored.set(`${kind}|${id}`, labels);
    },
    dropLabels: async (kind, id) => {
      stored.delete(`${kind}|${id}`);
    },
    audit: (entry) => audits.push(entry),
  };
  return { port, stored, audits };
}

function inTurn<T>(contextKey: string, readers: ReturnType<typeof readersOf>, initial: LabelSet | undefined, fn: () => Promise<T>) {
  const discretion = createDiscretionTurnState({
    contextKey,
    resolveReaders: async () => readers,
    ...(initial ? { initial } : {}),
  });
  return turnContext.run({ turnId: `t-${contextKey}`, turnDate: '2026-11-20', discretion }, fn);
}

describe('memory notes keep the labels of the turn that wrote them (criterion 27)', () => {
  it('a note written in the HR 1:1 refuses the sales answer and the CRM write weeks later', async () => {
    const { port, stored } = fakePort();
    const store = new LabelledMemoryStore(new InMemoryMemoryStore(), port, 'mira');
    await inTurn(HR_DM, hrReaders, unionLabels([hrSource]), () =>
      store.createFile('/memories/agent/p.md', 'P leaves at the end of the month'),
    );
    const kept = stored.get('memory_file|/memories/agent/p.md');
    assert.ok(kept?.labels.some((l) => l.kind === 'context' && l.key === HR_DM));
    assert.ok(kept?.labels.some((l) => l.kind === 'source' && l.system === '@omadia/odoo-hr'));

    await inTurn(SALES, salesReaders, undefined, async () => {
      await store.readFile('/memories/agent/p.md');
      assert.ok(currentTurnLabels().labels.some((l) => l.kind === 'context' && l.key === HR_DM));
      const answer = await peopleEgressDecision(turnContext.current()?.discretion);
      assert.equal(answer?.allowed, false, 'the sales room may not read it');
      const crm = await guardIntegrationEgress(port, 'crm_note', { system: '@omadia/crm', effect: 'write' });
      assert.ok(crm, 'the CRM write carrying it is refused');
    });
  });

  it('labels move with a renamed note and go with a deleted one; outside a turn nothing is recorded', async () => {
    const { port, stored } = fakePort();
    const store = new LabelledMemoryStore(new InMemoryMemoryStore(), port, 'mira');
    await inTurn(HR_DM, hrReaders, undefined, () => store.createFile('/memories/a.md', 'x'));
    await store.rename('/memories/a.md', '/memories/b.md');
    assert.equal(stored.has('memory_file|/memories/a.md'), false);
    assert.ok(stored.has('memory_file|/memories/b.md'));
    await store.delete('/memories/b.md');
    assert.equal(stored.has('memory_file|/memories/b.md'), false);
    await store.createFile('/memories/c.md', 'y');
    assert.equal(stored.has('memory_file|/memories/c.md'), false);
  });
});

describe('the memory egress (spec §5.11 "Memory write")', () => {
  it('another conversation\'s knowledge only goes into a tier whose readers may all know it', async () => {
    const { port, audits } = fakePort();
    // Own conversation only: always into its own tiers, even an agent-wide one.
    const own = await inTurn(SALES, salesReaders, undefined, () => guardMemoryEgress(port, { kind: 'unknown' }, 'memory'));
    assert.equal(own, undefined);
    // Recalled HR knowledge: not into the agent-wide tier, nor the sales members' tier …
    const wide = await inTurn(SALES, salesReaders, unionLabels([hrContext]), () =>
      guardMemoryEgress(port, { kind: 'unknown' }, 'memory'),
    );
    assert.match(wide ?? '', /nothing was written/);
    const members = await inTurn(SALES, salesReaders, unionLabels([hrContext]), () =>
      guardMemoryEgress(port, salesReaders, 'memory'),
    );
    assert.ok(members);
    // … but into a tier only the HR manager reads.
    const narrow = await inTurn(SALES, salesReaders, unionLabels([hrContext]), () =>
      guardMemoryEgress(port, hrReaders, 'memory'),
    );
    assert.equal(narrow, undefined);
    assert.ok(audits.some((a) => a.egress === 'memory' && !a.allowed));
    assert.equal(JSON.stringify(audits).includes('leaves'), false);
  });
});

/** Canonical id = channel id: enough identity for the roster rule. */
const knowledgeGraph = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'resolveOrCreateChannelIdentity') {
        return async (input: { channelUserId: string }) => ({ omadiaUserId: input.channelUserId });
      }
      return undefined;
    },
  },
) as unknown as KnowledgeGraph;

function groupTurn(members: string[]) {
  const participants = Object.assign(
    async () => members.map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
    { completeRoster: true },
  );
  return {
    input: {
      userMessage: 'Notier dir das bitte.',
      sessionScope: 'sales-group',
      userId: members[0],
      origin: {
        channelType: 'teams',
        scope: { kind: 'conversation', conversationId: 'sales' },
        conversationType: 'group',
        channelConversationId: 'sales',
      },
    } as ChatTurnInput,
    participants,
  };
}

describe('memory through the real orchestrator', () => {
  function build(
    responses: Parameters<typeof scriptedModel>[0],
    recall: { turns?: string[]; insights?: string[]; unlabelled?: boolean },
  ) {
    const narrow = unionLabels([hrContext]);
    const { port } = fakePort(
      recall.unlabelled
        ? []
        : [
            ...(recall.turns ?? []).map((id) => ['turn', id, narrow] as [LabelSubjectKind, string, LabelSet]),
            ...(recall.insights ?? []).map((id) => ['memorable', id, narrow] as [LabelSubjectKind, string, LabelSet]),
          ],
    );
    const memory = new InMemoryMemoryStore();
    const model = scriptedModel(responses);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 4,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      agentId: 'mira',
      knowledgeGraph,
      discretion: port,
      memoryToolHandler: new MemoryToolHandler(memory),
      contextRetriever: {
        assembleForBudget: async () => ({
          text: '\n[früher] P verlässt das Unternehmen',
          included: (recall.turns ?? []).map((turnId) => ({ turnId, score: 1, chars: 10, reason: 'fts', origin: 'fts' })),
          excluded: [],
          recalled: {
            plans: [],
            processes: [],
            insights: (recall.insights ?? []).map((mkId) => ({ mkId, kind: 'fact', summary: 'P verlässt', score: 1 })),
          },
          stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
        }),
      },
    } as unknown as OrchestratorOptions);
    return { orchestrator, model, memory };
  }

  it('a memory write carrying recalled HR knowledge into the agent-wide memory is refused, nothing is written', async () => {
    const { orchestrator, memory } = build(
      [
        toolCalls(['memory', { command: 'create', path: '/memories/p.md', file_text: 'P verlässt das Unternehmen' }]),
        text('Erledigt.'),
      ],
      { turns: ['turn-hr'] },
    );
    const { input, participants } = groupTurn(['hr-mgr']);
    await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(await memory.fileExists('/memories/p.md'), false);
  });

  it('the same write without foreign knowledge goes through (the dispatch hook is what refused above)', async () => {
    const { orchestrator, memory } = build(
      [
        toolCalls(['memory', { command: 'create', path: '/memories/p.md', file_text: 'Notiz aus diesem Chat' }]),
        text('Erledigt.'),
      ],
      {},
    );
    const { input, participants } = groupTurn(['hr-mgr']);
    await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(await memory.fileExists('/memories/p.md'), true);
  });

  it('a recalled memorable brings its labels: the answer to the sales group is withheld', async () => {
    const { orchestrator } = build([text('Kurz: P verlässt das Unternehmen.')], { insights: ['mk:1'] });
    const { input, participants } = groupTurn(['s1', 's2']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(result.text.includes('verlässt'), false);

    const control = build([text('Kurz: P verlässt das Unternehmen.')], { insights: ['mk:1'], unlabelled: true });
    const open = await turnContext.runWithChatParticipants(participants as never, () => control.orchestrator.chat(input));
    assert.match(open.text, /verlässt/, 'without stored labels the same recall answers');
  });
});
