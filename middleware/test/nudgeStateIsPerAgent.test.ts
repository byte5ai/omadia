import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  NudgeStateRecord,
  NudgeStateStore,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import { createNudgeTurnCounter } from '../packages/harness-orchestrator/src/nudgePipeline.js';

/**
 * Nudge state belongs to ONE agent, not to the process.
 *
 * The pipeline keys cooldowns, suppressions and open-emission follow-ups on
 * `(agentId, nudgeId)`. That key was the literal string `'orchestrator'` for
 * every agent in the process, which is invisible in a single-agent deployment
 * and wrong in every multi-agent one: agent A emitting a nudge put it on
 * cooldown for agent B, and B's next turn could mark A's emission as followed.
 *
 * A guard rather than a scenario test, because the cost of the bug is not that
 * something crashes — nothing does — but that two agents quietly share a
 * budget nobody can see them sharing.
 */

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
    // The pipeline classifies every tool in the turn trace by domain, so the
    // double has to answer that too — `undefined` is the real "no domain
    // registered" answer, not a stand-in.
    getDomain: () => undefined,
    listWithHandler: () => [],
  } as unknown as NativeToolRegistry;
}

/** Records every agent id the pipeline reads state for. */
class RecordingNudgeStateStore implements NudgeStateStore {
  readonly reads: Array<{ agentId: string; nudgeId: string }> = [];

  read(agentId: string, nudgeId: string): Promise<NudgeStateRecord | null> {
    this.reads.push({ agentId, nudgeId });
    return Promise.resolve(null);
  }

  recordEmission(): Promise<void> {
    return Promise.resolve();
  }

  recordFollow(): Promise<void> {
    return Promise.resolve();
  }

  recordRegression(): Promise<void> {
    return Promise.resolve();
  }

  suppress(): Promise<void> {
    return Promise.resolve();
  }
}

function deps(stateStore: NudgeStateStore): OrchestratorDeps {
  const registry = new InMemoryNudgeRegistry();
  // One provider, so the pipeline has a reason to read state at all. It never
  // fires — `evaluate` returning null is the common case and keeps this test
  // about the KEY rather than about nudge content.
  registry.register({
    id: 'test-provider',
    evaluate: () => Promise.resolve(null),
  } as never);
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: registry,
    nudgeStateStore: stateStore,
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are the platform assistant.',
  } as unknown as OrchestratorDeps;
}

function agentRow(slug: string): AgentRow {
  return {
    id: `00000000-0000-0000-0000-00000000000${slug.length}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as AgentRow;
}

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

/** Drive one tool result through the private pipeline. */
async function runPipeline(
  built: ReturnType<typeof buildForAgent>,
): Promise<void> {
  const orchestrator = built.orchestrator as unknown as {
    applyNudgePipeline(
      toolUses: unknown[],
      toolResults: unknown[],
      counter: unknown,
      cumulativeTrace: unknown[],
      input: unknown,
      turnId: string,
    ): Promise<void>;
  };
  await orchestrator.applyNudgePipeline(
    [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }],
    [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
    createNudgeTurnCounter(),
    [],
    { userMessage: 'hi', sessionScope: 'chat-1' },
    'turn-1',
  );
}

test('each agent reads its own nudge state, not a process-wide key', async () => {
  const store = new RecordingNudgeStateStore();
  const shared = deps(store);

  await runPipeline(buildForAgent(agentRow('hr'), shared, RUNTIME));
  await runPipeline(buildForAgent(agentRow('sales'), shared, RUNTIME));

  const agentIds = [...new Set(store.reads.map((r) => r.agentId))].sort();
  assert.deepEqual(
    agentIds,
    ['hr', 'sales'],
    'two agents in one process must not share one nudge-state key',
  );
  assert.equal(
    agentIds.includes('orchestrator'),
    false,
    'the literal process-wide key must be gone',
  );
});
