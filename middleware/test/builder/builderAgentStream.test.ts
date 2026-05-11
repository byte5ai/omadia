import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import type { AskObserver } from '@omadia/orchestrator';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { noopSlotTypechecker } from './fixtures/noopSlotTypechecker.js';
import {
  BuilderAgent,
  BUILDER_HEARTBEAT_INTERVAL_MS,
  type BuilderEvent,
  type BuilderSubAgentBuildOptions,
} from '../../src/plugins/builder/builderAgent.js';
import {
  patchSpecTool,
  fillSlotTool,
  lintSpecTool,
  type BuilderTool,
} from '../../src/plugins/builder/tools/index.js';

/**
 * Theme E1 — token-stream + phase events on the BuilderAgent surface.
 *
 * The LocalSubAgent observer fires onIterationPhase / onTokenChunk /
 * onIterationUsage as the SDK stream advances; runTurn must translate
 * these into BuilderEvents (stream_token_chunk, iteration_usage) and
 * extend the heartbeat payload with the current phase + per-iteration
 * token count. These tests use a fake sub-agent that drives the
 * observer directly so we can assert the wire shape without touching
 * the Anthropic SDK.
 */

interface Harness {
  draftStore: DraftStore;
  bus: SpecEventBus;
  userEmail: string;
  draftId: string;
  tmpRoot: string;
  agentFor: (
    subAgentBuilder: (opts: BuilderSubAgentBuildOptions) => {
      ask: (q: string, observer?: AskObserver) => Promise<string>;
    },
  ) => BuilderAgent;
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-stream-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const referenceRoot = path.join(tmpRoot, 'reference');
  mkdirSync(referenceRoot, { recursive: true });

  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Stream Draft');
  const bus = new SpecEventBus();
  const fakeAnthropic = {} as Anthropic;

  return {
    draftStore,
    bus,
    userEmail,
    draftId: draft.id,
    tmpRoot,
    agentFor(subAgentBuilder) {
      return new BuilderAgent({
        anthropic: fakeAnthropic,
        draftStore,
        bus,
        rebuildScheduler: { schedule() {} },
        catalogToolNames: () => [],
        knownPluginIds: () => [],
        slotTypechecker: noopSlotTypechecker,
        referenceCatalog: {
          'seo-analyst': { root: referenceRoot, description: 'test' },
        },
        systemPromptSeed: async () => 'TEST-SEED',
        buildSubAgent: subAgentBuilder,
        tools: [
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

describe('BuilderAgent — Theme E1 token-stream wiring', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('forwards onTokenChunk → stream_token_chunk events with cumulative + tokensPerSec', async () => {
    const agent = harness.agentFor(() => ({
      async ask(_q: string, observer?: AskObserver): Promise<string> {
        observer?.onIteration?.({ iteration: 0 });
        observer?.onIterationPhase?.({ iteration: 0, phase: 'thinking' });
        observer?.onIterationPhase?.({ iteration: 0, phase: 'streaming' });
        observer?.onTokenChunk?.({
          iteration: 0,
          deltaTokens: 5,
          cumulativeOutputTokens: 5,
          tokensPerSec: 10,
        });
        observer?.onTokenChunk?.({
          iteration: 0,
          deltaTokens: 7,
          cumulativeOutputTokens: 12,
          tokensPerSec: 14,
        });
        return 'streamed answer';
      },
    }));

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const chunks = events.filter((e) => e.type === 'stream_token_chunk');
    assert.equal(chunks.length, 2);
    const second = chunks[1];
    assert.ok(second?.type === 'stream_token_chunk');
    assert.equal(second.cumulativeOutputTokens, 12);
    assert.equal(second.deltaTokens, 7);
    assert.equal(second.tokensPerSec, 14);
  });

  it('forwards onIterationUsage → iteration_usage event carrying cacheReadInputTokens', async () => {
    const agent = harness.agentFor(() => ({
      async ask(_q: string, observer?: AskObserver): Promise<string> {
        observer?.onIteration?.({ iteration: 0 });
        observer?.onIterationUsage?.({
          iteration: 0,
          inputTokens: 1000,
          outputTokens: 25,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 0,
        });
        return 'done';
      },
    }));

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const usage = events.find((e) => e.type === 'iteration_usage');
    assert.ok(usage?.type === 'iteration_usage');
    assert.equal(usage.cacheReadInputTokens, 800);
    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 25);
  });

  it('heartbeat carries phase + tokensStreamedThisIter once observer hooks have fired', async () => {
    // Drive the observer hooks once, then sit silent for ≥ 2 heartbeat
    // cadences so the timer ticks at least twice with the new state.
    const silenceMs = BUILDER_HEARTBEAT_INTERVAL_MS * 2 + 500;
    const agent = harness.agentFor(() => ({
      async ask(_q: string, observer?: AskObserver): Promise<string> {
        observer?.onIteration?.({ iteration: 3 });
        observer?.onIterationPhase?.({ iteration: 3, phase: 'streaming' });
        observer?.onTokenChunk?.({
          iteration: 3,
          deltaTokens: 50,
          cumulativeOutputTokens: 200,
          tokensPerSec: 95,
        });
        await new Promise((r) => setTimeout(r, silenceMs));
        return 'done';
      },
    }));

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const heartbeats = events.filter((e) => e.type === 'heartbeat');
    assert.ok(
      heartbeats.length >= 1,
      `expected ≥ 1 heartbeat during ${String(silenceMs)}ms silence, got ${String(heartbeats.length)}`,
    );
    // The first heartbeat after the observer drove the hooks must reflect
    // the latest phase and per-iteration token count.
    const last = heartbeats[heartbeats.length - 1];
    assert.ok(last?.type === 'heartbeat');
    assert.equal(last.phase, 'streaming');
    assert.equal(last.tokensStreamedThisIter, 200);
    assert.equal(last.currentIteration, 3);
  });

  it('onIteration resets per-iteration counters (tokensStreamedThisIter back to 0)', async () => {
    // Two iterations: first accumulates tokens, second starts at zero.
    // The second iteration's heartbeat (or the order of stream_token_chunk
    // emissions) must reflect that reset.
    const agent = harness.agentFor(() => ({
      async ask(_q: string, observer?: AskObserver): Promise<string> {
        observer?.onIteration?.({ iteration: 0 });
        observer?.onTokenChunk?.({
          iteration: 0,
          deltaTokens: 30,
          cumulativeOutputTokens: 30,
          tokensPerSec: 60,
        });
        // Iteration boundary — counters must reset.
        observer?.onIteration?.({ iteration: 1 });
        observer?.onTokenChunk?.({
          iteration: 1,
          deltaTokens: 10,
          cumulativeOutputTokens: 10,
          tokensPerSec: 20,
        });
        return 'done';
      },
    }));

    const events = await collect(
      agent.runTurn({
        draftId: harness.draftId,
        userEmail: harness.userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-haiku-4-5-20251001',
      }),
    );

    const chunks = events.filter((e) => e.type === 'stream_token_chunk');
    assert.equal(chunks.length, 2);
    const second = chunks[1];
    assert.ok(second?.type === 'stream_token_chunk');
    // The second chunk's cumulativeOutputTokens (10) must NOT carry over
    // from iteration 0 (which ended at 30) — the LocalSubAgent helper
    // resets its closure state on every new stream, and onIteration on
    // the BuilderAgent side resets tokensStreamedThisIter to match.
    assert.equal(second.iteration, 1);
    assert.equal(second.cumulativeOutputTokens, 10);
  });
});
