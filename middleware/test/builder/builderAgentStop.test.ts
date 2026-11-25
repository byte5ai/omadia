import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type { AskOptions } from '@omadia/orchestrator';

import {
  BuilderAgent,
  type BuilderEvent,
  type BuilderSubAgentBuildOptions,
} from '../../src/plugins/builder/builderAgent.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import {
  UserChoiceCoordinator,
  type ChoiceOutcome,
} from '../../src/plugins/builder/userChoiceCoordinator.js';
import type { BuilderTool } from '../../src/plugins/builder/tools/index.js';

async function collect(stream: AsyncIterable<BuilderEvent>): Promise<BuilderEvent[]> {
  const events: BuilderEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('BuilderAgent — stopped turn (#2214)', () => {
  let tmp: string;
  let store: DraftStore;
  let bus: SpecEventBus;
  const userEmail = 'tester@example.com';
  let draftId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'builder-stop-'));
    store = new DraftStore({ dbPath: join(tmp, 'drafts.db') });
    await store.open();
    draftId = (await store.create(userEmail, 'Stop Draft')).id;
    bus = new SpecEventBus();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeAgent(opts: {
    ask: (
      sub: BuilderSubAgentBuildOptions,
      options: AskOptions | undefined,
    ) => Promise<string>;
    tools: BuilderTool<unknown, unknown>[];
    userChoice?: UserChoiceCoordinator;
  }): BuilderAgent {
    return new BuilderAgent({
      resolveProvider: async () => ({ provider: {} as never, modelId: 'claude-haiku-4-5-20251001' }),
      draftStore: store,
      bus,
      rebuildScheduler: { schedule: () => undefined },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: {
        async run() {
          return { ok: true, errors: [], reason: 'ok', summary: '', durationMs: 0 };
        },
      },
      referenceCatalog: {},
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: (sub) => ({
        ask: (_q, _observer, options) => opts.ask(sub, options),
      }),
      tools: opts.tools,
      templateRoot: tmp,
      ...(opts.userChoice ? { userChoice: opts.userChoice } : {}),
    });
  }

  it('ends at once, refuses later tool calls and writes no answer', async () => {
    let toolRuns = 0;
    const tool: BuilderTool<unknown, unknown> = {
      id: 'mutate',
      description: 'changes the draft',
      input: z.object({ note: z.string().optional() }),
      async run() {
        toolRuns += 1;
        return 'changed';
      },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let askStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    let seenSignal: AbortSignal | undefined;
    let resolveLateTool!: (output: string) => void;
    const lateToolOutput = new Promise<string>((resolve) => {
      resolveLateTool = resolve;
    });
    const agent = makeAgent({
      tools: [tool],
      ask: async (sub, options) => {
        seenSignal = options?.signal;
        askStarted();
        await gate;
        const bridged = sub.tools.find((t) => t.spec.name === 'mutate');
        const out = await bridged?.handle({});
        resolveLateTool(typeof out === 'string' ? out : (out?.output ?? ''));
        return 'late answer';
      },
    });
    const controller = new AbortController();
    const run = collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'what is the domain?',
        modelChoice: 'claude-sonnet-4-6',
        signal: controller.signal,
      }),
    );
    await started;
    controller.abort('operator');
    const last = (await run).at(-1);
    assert.equal(last?.type === 'error' ? last.code : '', 'builder.turn_stopped');
    assert.equal(seenSignal, controller.signal);

    // The detached ask goes on after the turn ended; its tool call is refused.
    release();
    assert.match(await lateToolOutput, /^Error: this builder turn was stopped/);
    assert.equal(toolRuns, 0);
    const draft = await store.load(userEmail, draftId);
    assert.equal(draft?.transcript.at(-1)?.role, 'user');
  });

  it('reports a timeout abort as builder.turn_timeout', async () => {
    const agent = makeAgent({
      tools: [],
      ask: () => new Promise<string>(() => {}),
    });
    const controller = new AbortController();
    const run = collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-sonnet-4-6',
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort('timeout'), 10);
    const last = (await run).at(-1);
    assert.equal(last?.type === 'error' ? last.code : '', 'builder.turn_timeout');
  });

  it('cancels the open choice card of the stopped turn', async () => {
    const userChoice = new UserChoiceCoordinator({ bus });
    let outcome: Promise<ChoiceOutcome> | undefined;
    const agent = makeAgent({
      tools: [],
      userChoice,
      ask: async () => {
        outcome = userChoice.create({
          draftId,
          question: 'which domain?',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        }).result;
        return new Promise<string>(() => {});
      },
    });
    const controller = new AbortController();
    const run = collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-sonnet-4-6',
        signal: controller.signal,
      }),
    );
    while (!outcome) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    controller.abort('operator');
    await run;
    const result = await outcome;
    assert.equal(result.ok, false);
    assert.equal(userChoice.pendingCount(), 0);
  });

  it('waits for a tool call already running, and still delivers its patch', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let toolFinished = false;
    const tool: BuilderTool<unknown, unknown> = {
      id: 'slow_write',
      description: 'writes the draft slowly',
      input: z.object({ note: z.string().optional() }),
      async run(_input, ctx) {
        toolStarted();
        await toolGate;
        ctx.bus.emit(ctx.draftId, {
          type: 'spec_patch',
          patches: [{ op: 'replace', path: '/name', value: 'late' }],
          cause: 'agent',
        });
        toolFinished = true;
        return 'written';
      },
    };
    const agent = makeAgent({
      tools: [tool],
      ask: async (sub) => {
        await sub.tools.find((t) => t.spec.name === 'slow_write')?.handle({});
        return new Promise<string>(() => {});
      },
    });
    const controller = new AbortController();
    let ended = false;
    const run = collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-sonnet-4-6',
        signal: controller.signal,
      }),
    ).then((events) => {
      ended = true;
      return events;
    });
    await started;
    controller.abort('operator');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(ended, false, 'the stopped turn waits for the running write');

    releaseTool();
    const events = await run;
    assert.equal(toolFinished, true);
    const types = events.map((e) => e.type);
    const patchAt = types.lastIndexOf('spec_patch');
    assert.ok(patchAt >= 0, 'the write that landed is still delivered');
    assert.equal(patchAt, types.length - 2);
    const last = events.at(-1);
    assert.equal(last?.type === 'error' ? last.code : '', 'builder.turn_stopped');
  });
});
