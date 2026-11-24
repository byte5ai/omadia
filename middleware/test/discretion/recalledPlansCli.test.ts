/**
 * Spec 2042 §5.11 / #2194 — two gaps of the recall card gate:
 *
 *  - a recalled plan brings the labels of the turn that wrote it, and a
 *    recalled or read process the labels its writes kept, so a plan or
 *    process from an HR 1:1 is neither shown (recall card) nor restated
 *    (answer) to a group with other readers;
 *  - a turn the subscription CLI answers runs with the same discretion state
 *    as an in-process turn, so its recall card and its answer go through the
 *    people-egress check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import type { KnowledgeGraph, ProcessMemoryService, ProcessRecord, RecalledContext } from '@omadia/plugin-api';

import type { ChatStreamEvent, ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { CliChatAgent, type CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { readersOf, unionLabels, type DiscretionLabel, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionAuditEntry, DiscretionPort, LabelSubjectKind } from '../../packages/harness-orchestrator/src/discretion/port.js';
import {
  addTurnLabels,
  createDiscretionTurnState,
  currentTurnLabels,
} from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import {
  createEditProcessHandler,
  createQueryProcessesHandler,
  createWriteProcessHandler,
} from '../../packages/harness-orchestrator/src/tools/processMemoryTool.js';
import { labelProcessMemory } from '../../packages/harness-orchestrator/src/discretion/labelledProcessMemory.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { scriptedModel, text } from '../_helpers/replayTurnFixture.js';

const HR_DM = 'teams:dm-hr';
const hrReaders = readersOf(['hr-mgr', 'p']);
const hrContext: DiscretionLabel = { kind: 'context', key: HR_DM, readers: hrReaders };
const narrow = unionLabels([hrContext]);
const ANSWER = 'Der Plan: Aufhebungsvertrag für P vorbereiten.';

function fakePort(seed: Array<[LabelSubjectKind, string, LabelSet]> = []) {
  const stored = new Map<string, LabelSet>(seed.map(([kind, id, labels]) => [`${kind}|${id}`, labels]));
  const audits: DiscretionAuditEntry[] = [];
  const port: DiscretionPort = {
    declarationOf: async () => undefined,
    labelsOf: async (kind, ids) =>
      new Map(ids.flatMap((id) => (stored.has(`${kind}|${id}`) ? [[id, stored.get(`${kind}|${id}`)!]] : []))),
    persistLabels: async (kind, id, _agent, labels) => {
      stored.set(`${kind}|${id}`, labels);
    },
    audit: (entry) => audits.push(entry),
  };
  return { port, stored, audits };
}

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
      userMessage: 'Wie war der Plan für P?',
      sessionScope: 'team-group',
      userId: members[0],
      origin: {
        channelType: 'teams',
        scope: { kind: 'conversation', conversationId: 'team' },
        conversationType: 'group',
        channelConversationId: 'team',
      },
    } as ChatTurnInput,
    participants,
  };
}

const PLAN = {
  planId: 'plan:hr-1',
  scope: 'mira::hr-dm',
  openStepGoals: ['Aufhebungsvertrag für P vorbereiten'],
  completedStepGoals: [],
  resumeFromInProgress: false,
  resumeFromSideEffecting: false,
  doneCount: 0,
  totalCount: 1,
};
const PROCESS = { id: 'process:hr:offboarding-p', title: 'HR: Offboarding P', scope: 'hr', stepCount: 2, score: 0.9 };

interface Setup {
  /** What the recall returns. */
  readonly recalled: RecalledContext;
  /** Labels the port knows. */
  readonly seed?: Array<[LabelSubjectKind, string, LabelSet]>;
}

function build(setup: Setup, extra: Partial<OrchestratorOptions> = {}) {
  const { port, audits } = fakePort(setup.seed);
  const model = scriptedModel([text(ANSWER)]);
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
    contextRetriever: {
      assembleForBudget: async () => ({
        text: '\n[früher] Plan: Aufhebungsvertrag für P vorbereiten',
        included: [],
        excluded: [],
        recalled: setup.recalled,
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
      }),
    },
    ...extra,
  } as unknown as OrchestratorOptions);
  return { orchestrator, audits };
}

const planFromHr: Setup = {
  recalled: { plans: [{ ...PLAN, turnId: 'turn-hr' }], processes: [], insights: [] },
  seed: [['turn', 'turn-hr', narrow]],
};
const planUnlabelled: Setup = {
  recalled: { plans: [{ ...PLAN, turnId: 'turn-hr' }], processes: [], insights: [] },
};
const processFromHr: Setup = {
  recalled: { plans: [], processes: [PROCESS], insights: [] },
  seed: [['process', PROCESS.id, narrow]],
};

function isRecallCard(e: { type: string; channel?: string }): boolean {
  return e.type === 'turn_annotation' && e.channel === 'kg_recall';
}

async function streamInProcess(setup: Setup, members: string[], extra: Partial<OrchestratorOptions> = {}) {
  const { orchestrator } = build(setup, extra);
  const { input, participants } = groupTurn(members);
  const events: ChatStreamEvent[] = [];
  await turnContext.runWithChatParticipants(participants as never, async () => {
    for await (const ev of orchestrator.chatStream(input)) events.push(ev);
  });
  return events;
}

describe('recalled plans and processes carry discretion labels (#2194)', () => {
  it('a plan written in the HR 1:1 is neither shown nor restated to a group with other readers', async () => {
    const events = await streamInProcess(planFromHr, ['hr-mgr', 's1']);
    assert.equal(events.filter(isRecallCard).length, 0, 'no recall card');
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal(done.answer.includes('Aufhebungsvertrag'), false, 'the answer is withheld');

    // The buffered path (Teams) drops the card with the withheld answer.
    const { orchestrator, audits } = build(planFromHr);
    const { input, participants } = groupTurn(['hr-mgr', 's1']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(result.text.includes('Aufhebungsvertrag'), false);
    assert.equal((result as { recalled?: unknown }).recalled, undefined);
    assert.ok(audits.some((a) => a.egress === 'people' && !a.allowed));
  });

  it('the same plan goes to the HR 1:1 itself, and without stored labels to the group', async () => {
    const own = await streamInProcess(planFromHr, ['hr-mgr', 'p']);
    assert.equal(own.filter(isRecallCard).length, 1, 'the room that wrote it sees its card');
    const unlabelled = await streamInProcess(planUnlabelled, ['hr-mgr', 's1']);
    assert.equal(unlabelled.filter(isRecallCard).length, 1, 'no stored labels: shown as before');
    const done = unlabelled.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done' && done.answer.includes('Aufhebungsvertrag'));
  });

  it('a recalled process from the HR 1:1 is withheld from the group', async () => {
    const events = await streamInProcess(processFromHr, ['hr-mgr', 's1']);
    assert.equal(events.filter(isRecallCard).length, 0);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done' && !done.answer.includes('Aufhebungsvertrag'));
  });

  describe('the labelled processMemory service', () => {
    const record: ProcessRecord = {
      id: PROCESS.id,
      scope: 'hr',
      title: PROCESS.title,
      steps: ['Vertrag', 'Gespräch'],
      visibility: 'team',
      version: 1,
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
    } as ProcessRecord;
    const raw = {
      write: async () => ({ ok: true, record }),
      edit: async () => ({ ok: true, record }),
      query: async () => [{ record, score: 0.9 }],
      get: async () => record,
      history: async () => [record],
    } as unknown as ProcessMemoryService;
    const inTurn = <T>(contextKey: string, readers: ReturnType<typeof readersOf>, fn: () => Promise<T>) =>
      turnContext.run(
        {
          turnId: `t-${contextKey}`,
          turnDate: '2026-11-24',
          agentSlug: 'mira',
          discretion: createDiscretionTurnState({ contextKey, resolveReaders: async () => readers }),
        },
        fn,
      );
    const hasHr = () => currentTurnLabels().labels.some((l) => l.kind === 'context' && l.key === HR_DM);

    it('write_process keeps the writing turn\'s labels; query, get and the plan-runner\'s query bring them back', async () => {
      const { port, stored } = fakePort();
      const service = labelProcessMemory(raw, port);
      await inTurn(HR_DM, hrReaders, () =>
        createWriteProcessHandler(service)({ title: PROCESS.title, steps: record.steps, scope: 'hr' }),
      );
      const kept = stored.get(`process|${PROCESS.id}`);
      assert.ok(kept?.labels.some((l) => l.kind === 'context' && l.key === HR_DM), 'the process keeps the HR label');

      const group = readersOf(['hr-mgr', 's1']);
      await inTurn('teams:team', group, async () => {
        await createQueryProcessesHandler(service)({ query: 'Offboarding' });
        assert.ok(hasHr(), 'query_processes');
      });
      await inTurn('teams:team', group, async () => {
        await service.get(PROCESS.id);
        assert.ok(hasHr(), 'get (run_stored_process)');
      });
      // The plan-runner reads the service directly in `onBeforeTurn`.
      await inTurn('teams:team', group, async () => {
        await service.query({ query: 'Offboarding P' });
        assert.ok(hasHr(), 'a direct query by another consumer');
      });
    });

    it('an edit keeps the earlier writes\' labels with its own; a duplicate hit labels the turn', async () => {
      const { port, stored } = fakePort([['process', PROCESS.id, narrow]]);
      const service = labelProcessMemory(raw, port);
      await inTurn('teams:sales', readersOf(['s1']), () =>
        createEditProcessHandler(service)({ id: PROCESS.id, steps: ['neu'] }),
      );
      const keys = stored.get(`process|${PROCESS.id}`)?.labels.flatMap((l) => (l.kind === 'context' ? [l.key] : []));
      assert.deepEqual(keys?.sort(), [HR_DM, 'teams:sales'].sort());

      const dup = labelProcessMemory(
        {
          ...raw,
          write: async () => ({
            ok: false,
            reason: 'duplicate',
            conflictingId: PROCESS.id,
            conflictingTitle: PROCESS.title,
            similarity: 0.99,
          }),
        } as unknown as ProcessMemoryService,
        port,
      );
      await inTurn('teams:team', readersOf(['s1']), async () => {
        await dup.write({ title: PROCESS.title, steps: ['x'], scope: 'hr' });
        assert.ok(hasHr());
      });
      assert.equal(labelProcessMemory(service, port), service, 'never wrapped twice');
    });

    it('the kernel registry decorates the provider as it registers', () => {
      const { port } = fakePort();
      const registry = new ServiceRegistry();
      registry.decorateOnProvide<ProcessMemoryService>('processMemory', (inner) => labelProcessMemory(inner, port));
      registry.provide('processMemory', raw, 'neon');
      assert.notEqual(registry.get('processMemory'), raw);
      assert.equal(labelProcessMemory(registry.get<ProcessMemoryService>('processMemory')!, port), registry.get('processMemory'));
    });
  });
});

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

const CLI_LINES = [
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER } },
  }),
  line({ type: 'result', subtype: 'success', is_error: false, result: ANSWER, num_turns: 1 }),
];

function cliAgentFor(
  orchestrator: Orchestrator,
  wired: boolean,
  extra: Partial<CliChatAgentDeps> = {},
): CliChatAgent {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [], agentSlug: 'mira' } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.187',
    logger: { info: () => undefined, warn: () => undefined },
    recallContext: (input) => orchestrator.recallCliContext(input),
    ...(wired
      ? {
          discretionTurnFields: (input: ChatTurnInput) => orchestrator.cliDiscretionTurnFields(input),
          guardAnswer: (answer: string, input: ChatTurnInput) => orchestrator.guardCliAnswer(answer, input),
        }
      : {}),
    spawnFn: (() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(new PassThrough(), {
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      stdin.resume();
      stdin.on('finish', () => {
        stdout.end(CLI_LINES.join(''));
        stderr.end('');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
    ...extra,
  });
}

async function streamCli(setup: Setup, members: string[], wired = true, extra: Partial<CliChatAgentDeps> = {}) {
  const { orchestrator } = build(setup);
  const agent = cliAgentFor(orchestrator, wired, extra);
  const { input, participants } = groupTurn(members);
  const events: ChatStreamEvent[] = [];
  await turnContext.runWithChatParticipants(participants as never, async () => {
    for await (const ev of agent.chatStream(input)) events.push(ev);
  });
  return { events, agent, input, participants };
}

describe('a CLI turn runs with the in-process discretion state (#2194)', () => {
  it('a CLI turn recalling the HR plan is withheld like an in-process one: no card, no answer', async () => {
    const { events } = await streamCli(planFromHr, ['hr-mgr', 's1']);
    assert.equal(events.filter(isRecallCard).length, 0, 'no recall card');
    const retract = events.find((e) => e.type === 'text_retract');
    assert.ok(retract && retract.type === 'text_retract' && retract.chars === ANSWER.length, 'the preview is taken back');
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal(done.answer.includes('Aufhebungsvertrag'), false, 'the answer is withheld');
  });

  it('chat() of a CLI turn returns the withheld line too', async () => {
    const { orchestrator } = build(planFromHr);
    const agent = cliAgentFor(orchestrator, true);
    const { input, participants } = groupTurn(['hr-mgr', 's1']);
    const answer = await turnContext.runWithChatParticipants(participants as never, () => agent.chat(input));
    assert.equal(answer.text.includes('Aufhebungsvertrag'), false);
  });

  it('the room that wrote the plan gets card and answer over the CLI; unwired, the gate is a no-op', async () => {
    const own = await streamCli(planFromHr, ['hr-mgr', 'p']);
    assert.equal(own.events.filter(isRecallCard).length, 1);
    const ownDone = own.events.find((e) => e.type === 'done');
    assert.ok(ownDone && ownDone.type === 'done' && ownDone.answer.includes('Aufhebungsvertrag'));

    // Before #2194 the CLI path had no discretion state: the card went out.
    const unwired = await streamCli(planFromHr, ['hr-mgr', 's1'], false);
    assert.equal(unwired.events.filter(isRecallCard).length, 1);
  });

  it('a CLI turn whose discretion state cannot be built fails closed', async () => {
    const { events } = await streamCli(planUnlabelled, ['hr-mgr', 's1'], true, {
      discretionTurnFields: async () => Promise.reject(new Error('roster down')),
    });
    assert.equal(events.filter(isRecallCard).length, 0);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done' && !done.answer.includes('Aufhebungsvertrag'));
  });

  it('a withheld CLI answer carries no cards and no record annotations', async () => {
    const { events } = await streamCli(planFromHr, ['hr-mgr', 's1'], true, {
      drainTurnCards: () => ({ followUpOptions: [{ label: 'Mehr zu P', prompt: 'Mehr zu P' }] }) as never,
      recordTurn: async () => ({
        turnId: 'turn-cli',
        events: [{ type: 'turn_annotation', channel: 'kg_insert', payload: { mk: 'P' } }],
      }),
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal((done as { followUpOptions?: unknown }).followUpOptions, undefined);
    assert.equal(done.turnId, 'turn-cli');
    assert.equal(events.some((e) => e.type === 'turn_annotation'), false);
  });
});

describe('cards derived from a withheld answer stay back on the stream (#2198)', () => {
  // A plan-runner-like hook: before the turn it reuses a process from the HR
  // 1:1 (reading it labels the turn, as the labelled service does) and shows
  // its plan; after the turn it shows the plan again.
  const planHooks = {
    run: async (point: string) => {
      if (point === 'onBeforeTurn') addTurnLabels(narrow);
      return point === 'onBeforeTurn' || point === 'onAfterTurn'
        ? [{ channel: 'plan', payload: { steps: ['Aufhebungsvertrag für P vorbereiten'], point } }]
        : [];
    },
  };

  it('no plan card and no after-turn annotation goes to the group with the withheld answer', async () => {
    const events = await streamInProcess(planFromHr, ['hr-mgr', 's1'], { turnHookRegistry: planHooks } as never);
    assert.equal(events.some((e) => e.type === 'turn_annotation'), false, JSON.stringify(events.map((e) => e.type)));
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done' && !done.answer.includes('Aufhebungsvertrag'));
  });

  it('the room that may read it gets the after-turn annotation', async () => {
    const events = await streamInProcess(planFromHr, ['hr-mgr', 'p'], { turnHookRegistry: planHooks } as never);
    const plans = events.filter((e) => e.type === 'turn_annotation' && (e as { channel?: string }).channel === 'plan');
    assert.ok(
      plans.some((e) => (e as { payload?: { point?: string } }).payload?.point === 'onAfterTurn'),
      'the after-turn card goes out with an answer that goes out',
    );
  });
});
