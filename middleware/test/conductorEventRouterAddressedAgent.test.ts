import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { addressedAgentForEvent } from '../src/conductor/channelBotOwnership.js';
import { ConductorEventRouter, foreignAgentSteps } from '../src/conductor/eventRouter.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

/**
 * Live finding 2026-11-21 (Fly): every message to "Mona (Test)" started a
 * workflow subscribed to a Teams event whose step `agent-4` runs as
 * `fallback`. The step-level origin rule refused it each time, so every
 * mention produced one failed run. A workflow whose agent steps belong to a
 * different agent than the addressed bot is now not started for that event.
 */

const MONA_BOT = '28:aaaaaaaa-1111-2222-3333-444444444444';
const DEFAULT_BOT = '28:bbbbbbbb-1111-2222-3333-444444444444';

function registry(): OrchestratorRegistry {
  const entry = (slug: string) => ({ agent: { slug, id: `id-${slug}` }, bindings: [] });
  return {
    identityForChannel: (type: string, key: string) =>
      type === 'teams' && key === MONA_BOT ? entry('mona-test') : undefined,
    identityOwnerFor: (type: string, key: string) =>
      type === 'teams' && key === MONA_BOT ? 'id-mona-test' : undefined,
    resolveByChannel: () => entry('fallback'),
    list: () => [entry('mona-test'), entry('fallback')],
  } as unknown as OrchestratorRegistry;
}

function graph(agentIds: string[]): WorkflowGraph {
  return {
    entryStepId: 'agent-1',
    steps: agentIds.map((agentId, i) => ({ id: `agent-${String(i + 1)}`, kind: 'agent', agentId, prompt: 'x' })),
    transitions: [],
    triggers: [{ id: 't1', kind: 'event', eventId: 'teams.message.posted' }],
  } as unknown as WorkflowGraph;
}

function router(graphs: Record<string, WorkflowGraph>, started: string[], logs: string[] = []): ConductorEventRouter {
  const workflowStore = {
    list: async () => Object.keys(graphs).map((slug) => ({ slug, status: 'enabled', activeVersionId: slug })),
    getVersion: async (id: string) => ({ id, workflowId: id, version: 1, graph: graphs[id] }),
  } as unknown as ConductorWorkflowStore;
  const executor = {
    startRun: async (input: { slug: string }) => {
      started.push(input.slug);
      return { id: `run-${input.slug}` };
    },
  } as unknown as ConductorRunExecutor;
  const reg = registry();
  return new ConductorEventRouter({
    workflowStore,
    executor,
    addressedAgent: (eventId, payload) => addressedAgentForEvent(reg, eventId, payload, () => DEFAULT_BOT),
    log: (m) => logs.push(m),
  });
}

describe('conductor event router — workflows for another agent are not started', () => {
  it('does not start a fallback workflow for a message to Mona, and says why', async () => {
    const started: string[] = [];
    const logs: string[] = [];
    const r = router({ 'default-bot-flow': graph(['fallback']) }, started, logs);

    const result = await r.emit('teams.message.posted', { botId: MONA_BOT, text: '@Mona hi' } as JsonObject);

    assert.deepEqual(started, []);
    assert.equal(result.matchedWorkflows, 1);
    assert.deepEqual(result.skippedWorkflows, [
      { workflowSlug: 'default-bot-flow', addressedAgent: 'mona-test', stepAgents: ['fallback'] },
    ]);
    assert.ok(logs.some((l) => l.includes("addressed to Agent 'mona-test'") && l.includes("'fallback'")));
  });

  it('still starts the same workflow for a message to the default bot', async () => {
    const started: string[] = [];
    const r = router({ 'default-bot-flow': graph(['fallback']) }, started);

    await r.emit('teams.message.posted', { botId: DEFAULT_BOT, text: 'hi' } as JsonObject);

    assert.deepEqual(started, ['default-bot-flow']);
  });

  it("starts a workflow whose agent steps all run as the addressed bot's agent", async () => {
    const started: string[] = [];
    const r = router({ 'mona-flow': graph(['mona-test', 'mona-test']), 'mixed': graph(['mona-test', 'fallback']) }, started);

    const result = await r.emit('teams.message.posted', { botId: MONA_BOT } as JsonObject);

    assert.deepEqual(started, ['mona-flow']);
    assert.deepEqual(result.skippedWorkflows.map((s) => s.workflowSlug), ['mixed']);
  });

  it('leaves non-channel events and unresolvable bots to the step-level rule', async () => {
    const started: string[] = [];
    const g = { ...graph(['fallback']), triggers: [{ id: 't', kind: 'event', eventId: 'orders.created' }] } as WorkflowGraph;
    const r = router({ orders: g, teams: graph(['fallback']) }, started);

    await r.emit('orders.created', { botId: MONA_BOT } as JsonObject);
    await r.emit('teams.message.posted', { botId: '28:unknown' } as JsonObject);
    await r.emit('teams.message.posted', { text: 'no bot id' } as JsonObject);

    assert.deepEqual(started, ['orders', 'teams', 'teams']);
  });

  it('foreignAgentSteps ignores non-agent steps', () => {
    const g = {
      entryStepId: 'a',
      steps: [
        { id: 'a', kind: 'action', actionId: 'noop' },
        { id: 'b', kind: 'agent', agentId: 'x' },
      ],
      transitions: [],
    } as unknown as WorkflowGraph;
    assert.deepEqual(foreignAgentSteps(g, 'x'), []);
    assert.deepEqual(foreignAgentSteps(g, 'y'), ['x']);
  });
});
