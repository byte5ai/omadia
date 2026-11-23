/**
 * Spec 2042 §6 criterion 1 — the Strategist regression, at the agent
 * runtime: two agents built by the registry's own builder (`buildForAgent`)
 * from shared deps. The Strategist's turn ends with a `done` whose speaker
 * AND finished run trace carry the Strategist's agent id; the second agent's
 * turn carries its own; and the second agent's model is offered no tool that
 * reaches the Strategist (no hidden agent-as-tool, no consultation without a
 * grant).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';
import { EntityRefBus, InMemoryNudgeRegistry } from '@omadia/plugin-api';

import type { ChatAgent, ChatStreamEvent } from '../packages/harness-channel-sdk/src/index.js';
import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { ScriptedModel, answer } from './orchestrator/memberScopedWorld.js';

const NOW = new Date('2026-11-20T00:00:00Z');

function row(id: string, slug: string, identityName: string): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const STRATEGIST = row('00000000-0000-0000-0000-00000000005a', 'strategist', 'Strategist');
const HELPER = row('00000000-0000-0000-0000-00000000005b', 'helper', 'Helper');
const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 2 };

/** One set of deps for both agents, as the registry shares them. */
function sharedDeps(model: ScriptedModel): OrchestratorDeps {
  const names = new Set<string>();
  return {
    provider: model.provider(),
    knowledgeGraph: new InMemoryKnowledgeGraph(),
    memoryStore: new InMemoryMemoryStore(),
    entityRefBus: new EntityRefBus(),
    nativeToolRegistry: {
      get: () => undefined,
      listWithHandler: () => [],
      has: (n: string) => names.has(n),
      register: (n: string) => {
        names.add(n);
        return () => names.delete(n);
      },
    },
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  } as unknown as OrchestratorDeps;
}

async function doneOf(agent: ChatAgent): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: ChatStreamEvent | undefined;
  for await (const event of agent.chatStream({ userMessage: 'Was ist unsere Strategie?', sessionScope: 'web::s1' })) {
    if (event.type === 'done') done = event;
  }
  assert.ok(done?.type === 'done', 'the turn ended without done');
  return done;
}

describe('criterion 1 — the Strategist answers as itself and is nobody else’s tool', () => {
  const model = new ScriptedModel();
  const deps = sharedDeps(model);
  // Built in the registry's order: the Strategist first, so anything it left
  // in the shared deps would be visible to the second agent.
  const strategist = buildForAgent(STRATEGIST, deps, {
    ...RUNTIME,
    agentDirectory: () => [{ agentId: HELPER.id, slug: 'helper', displayName: 'Helper' }],
  });
  const helper = buildForAgent(HELPER, deps, {
    ...RUNTIME,
    agentDirectory: () => [{ agentId: STRATEGIST.id, slug: 'strategist', displayName: 'Strategist' }],
  });

  it("criterion 1: the Strategist's finished run trace and speaker carry its agent id", async () => {
    model.push(answer('Wir fokussieren auf Bestandskunden.'));
    const done = await doneOf(strategist.bundle.agent);
    assert.equal(done.runTrace?.agentId, STRATEGIST.id);
    assert.equal((done as { speaker?: { agentId?: string } }).speaker?.agentId, STRATEGIST.id);
  });

  it('criterion 1: the second agent answers with its own id, never the Strategist’s', async () => {
    model.push(answer('Dazu frag bitte den Strategen.'));
    const done = await doneOf(helper.bundle.agent);
    assert.equal(done.runTrace?.agentId, HELPER.id);
    assert.equal((done as { speaker?: { agentId?: string } }).speaker?.agentId, HELPER.id);
  });

  it('criterion 1: no tool offered to the second agent reaches the Strategist', () => {
    const offered = [...(helper.bundle.agent.offeredToolNames?.() ?? helper.orchestrator.offeredToolNames())];
    assert.ok(offered.length > 0, 'the agent offers its kernel tools');
    for (const name of offered) {
      assert.doesNotMatch(name, /strategist|consult/i, `hidden route to the Strategist: ${name}`);
    }
    // Built alone, the second agent offers exactly the same tools: nothing of
    // the Strategist's build leaked into its tool list.
    const alone = buildForAgent(HELPER, sharedDeps(new ScriptedModel()), RUNTIME);
    assert.deepEqual(offered.sort(), [...alone.orchestrator.offeredToolNames()].sort());
  });
});
