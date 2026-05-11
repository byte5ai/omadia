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
 * Theme E0 — heartbeat liveness pulse.
 *
 * Two cases:
 *  - silent stream → heartbeats are emitted on the configured cadence
 *    with monotonically growing `sinceLastActivityMs` deltas
 *  - fast stream (well under the heartbeat interval) → no heartbeat emits
 *    because the timer never ticks before the turn closes
 */

interface Harness {
  draftStore: DraftStore;
  bus: SpecEventBus;
  userEmail: string;
  draftId: string;
  tmpRoot: string;
  agentFor: (subAgentBuilder: (opts: BuilderSubAgentBuildOptions) => {
    ask: (q: string, observer?: AskObserver) => Promise<string>;
  }) => BuilderAgent;
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-heartbeat-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const referenceRoot = path.join(tmpRoot, 'reference');
  mkdirSync(referenceRoot, { recursive: true });

  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Heartbeat Draft');
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

describe('BuilderAgent — Theme E0 heartbeat', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('emits heartbeats with growing sinceLastActivityMs while the LLM stream is silent', async () => {
    // Silence-window is ~2.5× the cadence so we observe at least 2 ticks
    // without flaking on slower CI hardware. observer.onIteration is
    // intentionally NOT called — the agent should still pulse from pure
    // wall-clock silence.
    const silenceMs = BUILDER_HEARTBEAT_INTERVAL_MS * 2 + 500;

    const agent = harness.agentFor(() => ({
      async ask(_q: string, _observer?: AskObserver): Promise<string> {
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
      heartbeats.length >= 2,
      `expected ≥ 2 heartbeats during ${String(silenceMs)}ms silence, got ${String(heartbeats.length)}`,
    );

    // sinceLastActivityMs must grow monotonically while the stream is silent.
    for (let i = 1; i < heartbeats.length; i += 1) {
      const prev = heartbeats[i - 1];
      const cur = heartbeats[i];
      if (prev?.type !== 'heartbeat' || cur?.type !== 'heartbeat') continue;
      assert.ok(
        cur.sinceLastActivityMs >= prev.sinceLastActivityMs,
        `heartbeat[${String(i)}].sinceLastActivityMs (${String(cur.sinceLastActivityMs)}) < prev (${String(prev.sinceLastActivityMs)})`,
      );
    }

    // currentIteration starts at 0 when onIteration is never invoked.
    const first = heartbeats[0];
    assert.ok(first?.type === 'heartbeat');
    assert.equal(first.currentIteration, 0);
    assert.equal(first.toolCallsThisIter, 0);
  });

  it('emits no heartbeats on a fast turn (sub-cadence)', async () => {
    // Resolve well under the 2s interval — the timer must not tick before
    // the turn closes and the cleanup `clearInterval` runs in `finally`.
    const agent = harness.agentFor(() => ({
      async ask(_q: string, _observer?: AskObserver): Promise<string> {
        await new Promise((r) => setTimeout(r, 10));
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
    assert.equal(
      heartbeats.length,
      0,
      `fast turn must not emit heartbeats, got ${String(heartbeats.length)}`,
    );
  });
});
