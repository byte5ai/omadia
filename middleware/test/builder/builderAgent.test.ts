import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import type { AskObserver } from '@omadia/orchestrator';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type { SlotTypecheckService } from '../../src/plugins/builder/slotTypecheckPipeline.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import { noopSlotTypechecker } from './fixtures/noopSlotTypechecker.js';
import {
  BuilderAgent,
  composeContextualMessage,
  detectBuildIntent,
  type BuilderEvent,
  type BuilderSubAgentBuildOptions,
} from '../../src/plugins/builder/builderAgent.js';
import {
  patchSpecTool,
  fillSlotTool,
  lintSpecTool,
  readReferenceTool,
  type BuilderTool,
} from '../../src/plugins/builder/tools/index.js';

interface ScriptedToolCall {
  id: string;
  name: string;
  input: unknown;
  output: string;
  isError?: boolean;
  durationMs?: number;
}

interface FakeAskScript {
  toolCalls?: ScriptedToolCall[];
  finalText: string;
  throws?: Error;
}

function makeFakeBuildSubAgent(
  script: FakeAskScript,
  recordedTools: { value: ReadonlyArray<{ name: string }> } = { value: [] },
): (opts: BuilderSubAgentBuildOptions) => { ask: (q: string, observer?: AskObserver) => Promise<string> } {
  return (opts) => {
    recordedTools.value = opts.tools.map((t) => ({ name: t.spec.name }));
    return {
      async ask(_q: string, observer?: AskObserver): Promise<string> {
        if (script.throws) throw script.throws;
        if (script.toolCalls) {
          for (const tc of script.toolCalls) {
            observer?.onSubToolUse?.({ id: tc.id, name: tc.name, input: tc.input });
            // Actually run the tool through the bridged handle so SpecEventBus
            // events fire. The handler is exposed via opts.tools[i].handle.
            const matched = opts.tools.find((t) => t.spec.name === tc.name);
            let output = tc.output;
            let isError = tc.isError ?? false;
            if (matched) {
              try {
                output = await matched.handle(tc.input);
              } catch (err) {
                output = `Error: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
            }
            observer?.onSubToolResult?.({
              id: tc.id,
              output,
              durationMs: tc.durationMs ?? 1,
              isError,
            });
          }
        }
        return script.finalText;
      },
    };
  };
}

interface Harness {
  draftStore: DraftStore;
  bus: SpecEventBus;
  userEmail: string;
  draftId: string;
  rebuilds: Array<{ userEmail: string; draftId: string }>;
  referenceRoot: string;
  referenceCatalog: Record<string, { root: string; description: string }>;
  tmpRoot: string;
  agentFor: (overrides?: {
    script?: FakeAskScript;
    tools?: BuilderTool<unknown, unknown>[];
    slotTypechecker?: SlotTypecheckService;
  }) => BuilderAgent;
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-agent-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const referenceRoot = path.join(tmpRoot, 'reference');
  mkdirSync(referenceRoot, { recursive: true });
  const referenceCatalog = {
    'seo-analyst': { root: referenceRoot, description: 'test reference' },
  };

  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Test Draft');
  const bus = new SpecEventBus();
  const rebuilds: Array<{ userEmail: string; draftId: string }> = [];

  const fakeAnthropic = {} as Anthropic;

  return {
    draftStore,
    bus,
    userEmail,
    draftId: draft.id,
    rebuilds,
    referenceRoot,
    referenceCatalog,
    tmpRoot,
    agentFor(overrides) {
      return new BuilderAgent({
        anthropic: fakeAnthropic,
        draftStore,
        bus,
        rebuildScheduler: {
          schedule(email: string, draftId: string) {
            rebuilds.push({ userEmail: email, draftId });
          },
        },
        catalogToolNames: () => [],
        knownPluginIds: () => [],
        slotTypechecker: overrides?.slotTypechecker ?? noopSlotTypechecker,
        referenceCatalog,
        systemPromptSeed: async () => 'TEST-SEED',
        buildSubAgent: makeFakeBuildSubAgent(
          overrides?.script ?? { finalText: 'ok' },
        ),
        tools: (overrides?.tools as ReadonlyArray<BuilderTool<unknown, unknown>>) ?? [
          patchSpecTool as unknown as BuilderTool<unknown, unknown>,
          fillSlotTool as unknown as BuilderTool<unknown, unknown>,
          lintSpecTool as unknown as BuilderTool<unknown, unknown>,
        ],
      });
    },
    async dispose() {
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function collect(stream: AsyncIterable<BuilderEvent>): Promise<BuilderEvent[]> {
  const out: BuilderEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('BuilderAgent.runTurn', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('yields turn_started, user chat_message, assistant chat_message, and turn_done for a simple turn', async () => {
    const agent = harness.agentFor({ script: { finalText: 'Got it.' } });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'Build me a weather agent.',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'turn_started',
      'chat_message',
      'chat_message',
      'turn_done',
    ]);

    const startEv = events[0];
    assert.equal(startEv.type, 'turn_started');
    const doneEv = events[3];
    assert.equal(doneEv.type, 'turn_done');
    if (startEv.type === 'turn_started' && doneEv.type === 'turn_done') {
      assert.equal(startEv.turnId, doneEv.turnId);
    }

    const userEv = events[1];
    assert.equal(userEv.type, 'chat_message');
    if (userEv.type === 'chat_message') {
      assert.equal(userEv.role, 'user');
      assert.equal(userEv.text, 'Build me a weather agent.');
    }

    const assistantEv = events[2];
    if (assistantEv.type === 'chat_message') {
      assert.equal(assistantEv.role, 'assistant');
      assert.equal(assistantEv.text, 'Got it.');
    }
  });

  it('reuses an explicit turnId in turn_started + turn_done when caller passes opts.turnId', async () => {
    const agent = harness.agentFor({ script: { finalText: 'ok' } });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hi',
        modelChoice: 'claude-haiku-4-5-20251001',
        turnId: 'pinned-turn-id',
      }),
    );
    const startEv = events[0];
    const doneEv = events[events.length - 1];
    assert.equal(startEv?.type, 'turn_started');
    assert.equal(doneEv?.type, 'turn_done');
    if (startEv?.type === 'turn_started') {
      assert.equal(startEv.turnId, 'pinned-turn-id');
    }
    if (doneEv?.type === 'turn_done') {
      assert.equal(doneEv.turnId, 'pinned-turn-id');
    }
  });

  it('persists user + assistant turns to draft.transcript', async () => {
    const agent = harness.agentFor({ script: { finalText: 'reply' } });
    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hi',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.equal(reloaded?.transcript.length, 2);
    assert.equal(reloaded?.transcript[0].role, 'user');
    assert.equal(reloaded?.transcript[0].content, 'hi');
    assert.equal(reloaded?.transcript[1].role, 'assistant');
    assert.equal(reloaded?.transcript[1].content, 'reply');
    // preview transcript untouched
    assert.equal(reloaded?.previewTranscript.length, 0);
  });

  it('injects prior transcript as a context block into the user message passed to ask()', async () => {
    // Pre-populate the draft transcript with a previous turn so the agent
    // has something to inject. Without this, a user answering an earlier
    // architecture-fork question loses context on the next turn.
    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      transcript: [
        {
          role: 'user',
          content: 'Build a Meetup-RSVP agent.',
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: 'Welche API nutzt ihr?',
          timestamp: 2,
        },
      ],
    });

    let captured: string | null = null;
    const captureBuildSubAgent = (
      _opts: BuilderSubAgentBuildOptions,
    ): { ask: (q: string, observer?: AskObserver) => Promise<string> } => ({
      async ask(q: string, _observer?: AskObserver): Promise<string> {
        captured = q;
        return 'noted';
      },
    });

    const agent = new BuilderAgent({
      anthropic: {} as Anthropic,
      draftStore: harness.draftStore,
      bus: harness.bus,
      rebuildScheduler: { schedule: () => {} },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: harness.referenceCatalog,
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: captureBuildSubAgent,
      tools: [],
    });

    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'Wir nehmen die offizielle Meetup-API.',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    assert.ok(captured, 'expected ask() to receive a question');
    const q = captured ?? '';
    assert.ok(
      q.includes('<conversation-history>'),
      `expected history wrapper, got: ${q.slice(0, 200)}`,
    );
    assert.ok(q.includes('Build a Meetup-RSVP agent.'));
    assert.ok(q.includes('Welche API nutzt ihr?'));
    assert.ok(q.includes('<current-user-message>'));
    assert.ok(q.includes('Wir nehmen die offizielle Meetup-API.'));
  });

  it('passes the bare user message through when the transcript is empty', async () => {
    let captured: string | null = null;
    const agent = new BuilderAgent({
      anthropic: {} as Anthropic,
      draftStore: harness.draftStore,
      bus: harness.bus,
      rebuildScheduler: { schedule: () => {} },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: harness.referenceCatalog,
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: () => ({
        async ask(q: string): Promise<string> {
          captured = q;
          return 'ack';
        },
      }),
      tools: [],
    });

    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'erste Nachricht',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    assert.equal(captured, 'erste Nachricht');
  });

  it('emits tool_use + tool_result + downstream spec_patch when patch_spec is called', async () => {
    const agent = harness.agentFor({
      script: {
        toolCalls: [
          {
            id: 'use-1',
            name: 'patch_spec',
            input: {
              patches: [{ op: 'replace', path: '/name', value: 'Renamed' }],
            },
            output: '',
          },
        ],
        finalText: 'Updated.',
      },
    });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'rename to Renamed',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool_use'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('spec_patch'));
    assert.ok(types.includes('turn_done'));

    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.equal(reloaded?.spec.name, 'Renamed');
    assert.equal(harness.rebuilds.length, 1);
  });

  it('emits slot_patch when fill_slot tool is called', async () => {
    const agent = harness.agentFor({
      script: {
        toolCalls: [
          {
            id: 'use-1',
            name: 'fill_slot',
            input: { slotKey: 'activate-body', source: 'init();' },
            output: '',
          },
        ],
        finalText: 'Slot set.',
      },
    });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'fill the slot',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    const slotEvent = events.find((e) => e.type === 'slot_patch');
    assert.ok(slotEvent);
    if (slotEvent && slotEvent.type === 'slot_patch') {
      assert.equal(slotEvent.slotKey, 'activate-body');
      assert.equal(slotEvent.cause, 'agent');
    }
  });

  it('prefixes "Error:" when a builder tool returns { ok: false } so isError detection works', async () => {
    // Regression: read_reference returns a structured ErrResult
    // ({ok:false, error:"..."}) which the bridge used to JSON.stringify
    // as-is. LocalSubAgent then logged "→ ok" and Anthropic saw
    // is_error:false — the model interpreted the failure as "interesting
    // output" and looped through 11 read_reference tries before moving
    // on. The fix in bridgeBuilderTool prefixes "Error:" for
    // {ok:false} results so isError detection downstream + the
    // tool_result is_error flag both fire correctly.
    const agent = harness.agentFor({
      script: {
        finalText: 'noted',
        toolCalls: [
          {
            id: 'use-1',
            name: 'read_reference',
            input: { file: 'src/imaginary.ts' },
            output: '',
          },
        ],
      },
      tools: [
        readReferenceTool as unknown as BuilderTool<unknown, unknown>,
      ],
    });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'browse the reference',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult, 'expected a tool_result event');
    if (toolResult.type !== 'tool_result') throw new Error('unexpected');
    assert.ok(
      toolResult.output.startsWith('Error:'),
      `expected output to start with "Error:", got: ${toolResult.output.slice(0, 80)}`,
    );
    // Should reference the whitelist failure (input was 'src/imaginary.ts').
    assert.match(toolResult.output, /whitelist|exist/i);
  });

  it('yields error event when ask throws', async () => {
    const agent = harness.agentFor({
      script: { finalText: '', throws: new Error('boom') },
    });
    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hi',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    const errorEv = events.find((e) => e.type === 'error');
    assert.ok(errorEv);
    if (errorEv && errorEv.type === 'error') {
      assert.equal(errorEv.code, 'builder.ask_failed');
      assert.match(errorEv.message, /boom/);
    }
    // No assistant chat_message + no turn_done after error.
    assert.ok(!events.some((e) => e.type === 'turn_done'));
  });

  it('yields turn_started + draft_not_found error and does not invoke the sub-agent', async () => {
    const agent = harness.agentFor({ script: { finalText: 'should-never-run' } });
    const events = await collect(
      agent.runTurn({
        draftId: 'nonexistent',
        userEmail: harness.userEmail,
        userMessage: 'hi',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    // turn_started always lands first so a re-attaching client knows the
    // turnId before it sees any failure surface.
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'turn_started');
    assert.equal(events[1]?.type, 'error');
    if (events[1]?.type === 'error') {
      assert.equal(events[1].code, 'builder.draft_not_found');
    }
  });

  it('cleans up its bus subscription after the turn completes', async () => {
    const agent = harness.agentFor({ script: { finalText: 'done' } });
    assert.equal(harness.bus.listenerCount(harness.draftId), 0);
    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hi',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    assert.equal(harness.bus.listenerCount(harness.draftId), 0);
  });

  it('does not forward user-cause bus events through the turn stream', async () => {
    // Simulate a concurrent user PATCH while a turn is running.
    const agent = harness.agentFor({
      script: {
        toolCalls: [
          // Use a no-op tool call that produces nothing on the bus, then
          // emit a user-cause event manually mid-turn.
        ],
        finalText: 'done',
      },
    });
    const stream = agent.runTurn({
      draftId: harness.draftId,
      userEmail: harness.userEmail,
      userMessage: 'hi',
      modelChoice: 'claude-haiku-4-5-20251001',
    });
    // Fire the user event before starting iteration so subscription is set
    // up by the time we drain.
    setTimeout(() => {
      harness.bus.emit(harness.draftId, {
        type: 'spec_patch',
        patches: [{ op: 'replace', path: '/name', value: 'X' }],
        cause: 'user',
      });
    }, 1);
    const events = await collect(stream);
    // The user-cause spec_patch must NOT appear in the agent stream.
    const userEvents = events.filter((e) => e.type === 'spec_patch');
    assert.equal(userEvents.length, 0);
  });
});

describe('BuilderAgent — B.7 retry-counter turn isolation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  function alwaysFailingTypechecker(): SlotTypecheckService {
    return {
      async run() {
        return {
          ok: false,
          errors: [{ path: 'src/x.ts', line: 1, col: 1, code: 'TS2304', message: 'bad' }],
          reason: 'tsc',
          summary: 'tsc found 1 error(s)',
          durationMs: 5,
        };
      },
    };
  }

  function collectBusEvents(): SpecBusEvent[] {
    const events: SpecBusEvent[] = [];
    harness.bus.subscribe(harness.draftId, (e) => events.push(e));
    return events;
  }

  it('emits agent_stuck on the 3rd consecutive fill_slot fail within ONE turn', async () => {
    const events = collectBusEvents();
    const agent = harness.agentFor({
      slotTypechecker: alwaysFailingTypechecker(),
      script: {
        toolCalls: [
          { id: 't1', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'a();' }, output: '' },
          { id: 't2', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'b();' }, output: '' },
          { id: 't3', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'c();' }, output: '' },
        ],
        finalText: 'gave up',
      },
    });

    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'fill the slot',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const stuck = events.filter((e) => e.type === 'agent_stuck');
    assert.equal(stuck.length, 1, 'agent_stuck must fire once after 3 failures');
    if (stuck[0]?.type === 'agent_stuck') {
      assert.equal(stuck[0].slotKey, 'tool-handlers');
      assert.equal(stuck[0].attempts, 3);
    }
  });

  it('does NOT carry the retry count across turn boundaries — fresh budget per turn', async () => {
    const events = collectBusEvents();
    const agent = harness.agentFor({
      slotTypechecker: alwaysFailingTypechecker(),
    });

    // Turn 1: 2 failures → no stuck event yet.
    let agentForTurn = harness.agentFor({
      slotTypechecker: alwaysFailingTypechecker(),
      script: {
        toolCalls: [
          { id: 'a1', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'x();' }, output: '' },
          { id: 'a2', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'y();' }, output: '' },
        ],
        finalText: 'turn1 ende',
      },
    });
    await collect(
      agentForTurn.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'turn 1',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );
    assert.equal(events.filter((e) => e.type === 'agent_stuck').length, 0);

    // Turn 2: 2 more failures → still no stuck event because Turn 2 started
    // with a fresh tracker (would-be 3rd cumulative failure but only 2nd
    // within Turn 2).
    agentForTurn = harness.agentFor({
      slotTypechecker: alwaysFailingTypechecker(),
      script: {
        toolCalls: [
          { id: 'b1', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'z();' }, output: '' },
          { id: 'b2', name: 'fill_slot', input: { slotKey: 'tool-handlers', source: 'w();' }, output: '' },
        ],
        finalText: 'turn2 ende',
      },
    });
    await collect(
      agentForTurn.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'turn 2',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    assert.equal(
      events.filter((e) => e.type === 'agent_stuck').length,
      0,
      'turn-isolation broken: 2+2 fails must NOT trigger agent_stuck',
    );

    // Stub `agent` to silence "unused" lint hint.
    void agent;
  });
});

describe('BuilderAgent — B.8 manifest-linter E2E', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('rejects a patch with unresolvable depends_on, accepts the corrected re-issue', async () => {
    // Seed a near-valid spec the agent only has to fix the depends_on on.
    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      spec: {
        template: 'agent-integration',
        id: 'de.byte5.agent.weather',
        name: 'Weather',
        version: '0.1.0',
        description: 'fixture',
        category: 'analysis',
        depends_on: [],
        tools: [{ id: 'get_forecast', description: 'a' }],
        skill: { role: 'tester' },
        setup_fields: [],
        playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
        network: { outbound: ['api.openweather.org'] },
        slots: {},
      } as never,
    });

    const knownIds = ['de.byte5.integration.openweather'];
    const agent = new BuilderAgent({
      anthropic: {} as Anthropic,
      draftStore: harness.draftStore,
      bus: harness.bus,
      rebuildScheduler: { schedule: () => {} },
      catalogToolNames: () => [],
      knownPluginIds: () => knownIds,
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: harness.referenceCatalog,
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: makeFakeBuildSubAgent({
        toolCalls: [
          {
            id: 'tc-1',
            name: 'patch_spec',
            input: {
              patches: [{ op: 'add', path: '/depends_on/-', value: 'unknown.plugin' }],
            },
            output: '',
          },
          {
            id: 'tc-2',
            name: 'patch_spec',
            input: {
              patches: [
                { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.openweather' },
              ],
            },
            output: '',
          },
        ],
        finalText: 'fixed',
      }),
      tools: [patchSpecTool as unknown as BuilderTool<unknown, unknown>],
    });

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'add the openweather dependency',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    // Tool-result event for the first call should signal failure with
    // manifest-linter violation; the second should signal success.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    assert.equal(toolResults.length, 2, 'expected 2 tool_result events');
    if (toolResults[0]?.type === 'tool_result') {
      assert.match(toolResults[0].output, /manifest-linter/);
      assert.match(toolResults[0].output, /depends_on_unresolvable/);
    }
    // After both calls, spec should reflect the SECOND patch (good
    // depends_on) — first call's broken state was rejected and never
    // persisted.
    const final = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.deepEqual(final?.spec.depends_on, ['de.byte5.integration.openweather']);
  });

  it('accepts the canonical minimal-spec fixture (regression guard against over-strict linter)', async () => {
    // Snapshot-style guard: a spec we know works in production (minimal-
    // spec.json fixture) must always pass the linter. If a future change
    // to the linter rejects it, this test fails loudly so the change is
    // re-examined.
    const minimalSpec = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, 'fixtures', 'minimal-spec.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const { slots: _slots, ...specRest } = minimalSpec;
    void _slots;

    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      spec: specRest as never,
    });

    const agent = new BuilderAgent({
      anthropic: {} as Anthropic,
      draftStore: harness.draftStore,
      bus: harness.bus,
      rebuildScheduler: { schedule: () => {} },
      catalogToolNames: () => [],
      // Ensure depends_on resolves so the linter validates against full
      // catalog state.
      knownPluginIds: () => ['de.byte5.integration.openweather'],
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: harness.referenceCatalog,
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: makeFakeBuildSubAgent({
        // Re-issue a no-op patch (replace name with same value) to trigger
        // the full validation pipeline without changing anything.
        toolCalls: [
          {
            id: 'noop-1',
            name: 'patch_spec',
            input: {
              patches: [{ op: 'replace', path: '/name', value: specRest['name'] }],
            },
            output: '',
          },
        ],
        finalText: 'ok',
      }),
      tools: [patchSpecTool as unknown as BuilderTool<unknown, unknown>],
    });

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'noop',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result, 'expected a tool_result');
    if (result?.type === 'tool_result') {
      assert.equal(result.isError, false);
      assert.match(result.output, /"ok":\s*true/);
    }
  });
});

describe('BuilderAgent — system prompt seed', () => {
  it('reads builder-system.md and boilerplate CLAUDE.md by default (smoke)', async () => {
    const { defaultSystemPromptSeed } = await import(
      '../../src/plugins/builder/builderAgent.js'
    );
    const seed = await defaultSystemPromptSeed();
    assert.match(seed, /Builder Agent/);
    assert.match(seed, /<boilerplate-contract>/);
    assert.match(seed, /agent-seo-analyst/);
  });
});

describe('BuilderAgent.runTurn — OB-31 askOptions wiring', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  async function runWithMessage(message: string): Promise<{
    capturedOptions: { value: unknown };
  }> {
    const capturedOptions: { value: unknown } = { value: 'NEVER_SET' };
    const buildSubAgent = (
      _opts: BuilderSubAgentBuildOptions,
    ): {
      ask: (
        q: string,
        observer?: AskObserver,
        options?: unknown,
      ) => Promise<string>;
    } => ({
      async ask(_q, _observer, options) {
        capturedOptions.value = options ?? null;
        return 'ok';
      },
    });
    const agent = new BuilderAgent({
      anthropic: {} as Anthropic,
      draftStore: harness.draftStore,
      bus: harness.bus,
      rebuildScheduler: {
        schedule(email: string, draftId: string) {
          harness.rebuilds.push({ userEmail: email, draftId });
        },
      },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: harness.referenceCatalog,
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent,
      tools: [
        fillSlotTool as unknown as BuilderTool<unknown, unknown>,
      ],
      templateRoot: harness.tmpRoot,
    });
    await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: message,
        modelChoice: 'claude-haiku',
      }),
    );
    return { capturedOptions };
  }

  it('passes expectedTurnToolUse=fill_slot when user message is a build command', async () => {
    const { capturedOptions } = await runWithMessage('baue alle slots durch');
    assert.deepEqual(capturedOptions.value, {
      expectedTurnToolUse: 'fill_slot',
    });
  });

  it('passes undefined askOptions when user message is a question', async () => {
    const { capturedOptions } = await runWithMessage(
      'was macht fill_slot eigentlich?',
    );
    // BuilderAgent forwards `undefined` (not an empty object) so the
    // LocalSubAgent path stays exactly as it was pre-OB-31.
    assert.equal(capturedOptions.value, null);
  });
});

describe('detectBuildIntent — OB-31 phase heuristic', () => {
  it('matches imperative build verbs paired with slot/all/plugin objects', () => {
    assert.equal(detectBuildIntent('baue alle slots durch'), true);
    assert.equal(detectBuildIntent('Baue alle Slots durch'), true);
    assert.equal(detectBuildIntent('fill all the slots now please'), true);
    assert.equal(
      detectBuildIntent('schreibe alle Slots in einem Zug'),
      true,
    );
    assert.equal(detectBuildIntent('implementiere das plugin'), true);
    assert.equal(detectBuildIntent('build the plugin'), true);
    assert.equal(detectBuildIntent('fülle den slot client-impl'), true);
  });

  it('matches compact build directives without an explicit object', () => {
    assert.equal(detectBuildIntent('jetzt bauen'), true);
    assert.equal(detectBuildIntent('los, durchbauen!'), true);
    assert.equal(detectBuildIntent('losbauen bitte'), true);
  });

  it('does NOT match questions about build verbs', () => {
    // Mentions "fill_slot" / "build" but is asking, not commanding.
    assert.equal(detectBuildIntent('was macht fill_slot eigentlich?'), false);
    assert.equal(
      detectBuildIntent('kannst du mir sagen wie ich slots befülle?'),
      false,
    );
    assert.equal(
      detectBuildIntent('soll ich das durchbauen oder noch warten?'),
      true,
      // NOTE: this IS technically a question, but contains "durchbauen"
      // which is on the direct-pattern list. Marked as known false-pos —
      // documented to keep the heuristic conservative on the imperative
      // side. The user can recover by adding "warte" / asking again, and
      // the LocalSubAgent escalation only triggers if the model itself
      // refuses to call fill_slot.
    );
  });

  it('does NOT match unrelated chitchat', () => {
    assert.equal(detectBuildIntent('hi, was geht?'), false);
    assert.equal(
      detectBuildIntent('zeig mir bitte die referenzen für seo-analyst'),
      false,
    );
    assert.equal(detectBuildIntent('erkläre mir den build-failure-budget mechanismus'), false);
  });

  it('handles mixed-case and punctuation', () => {
    assert.equal(detectBuildIntent('BAUE ALLE SLOTS!!!'), true);
    assert.equal(detectBuildIntent('Build, all the slots, now.'), true);
  });
});

describe('composeContextualMessage', () => {
  it('returns the bare current message when transcript is empty', () => {
    assert.equal(composeContextualMessage([], 'hi'), 'hi');
  });

  it('wraps prior turns in <conversation-history> with role + index', () => {
    const out = composeContextualMessage(
      [
        { role: 'user', content: 'first', timestamp: 1 },
        { role: 'assistant', content: 'reply', timestamp: 2 },
      ],
      'now',
    );
    assert.match(out, /<conversation-history>/);
    assert.match(out, /<turn n="1" role="user">\nfirst\n<\/turn>/);
    assert.match(out, /<turn n="2" role="assistant">\nreply\n<\/turn>/);
    assert.match(out, /<\/conversation-history>/);
    assert.match(out, /<current-user-message>\nnow\n<\/current-user-message>/);
  });
});
