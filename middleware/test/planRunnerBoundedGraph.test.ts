/**
 * ADR-0044 — the plan runner gets the bounded `knowledgeGraph@1` and
 * `processMemory@1`, not the raw services. Its hooks run inside a turn with a
 * bound graph boundary and touch only the turn's own plans, so the whole
 * lifecycle (plan, step progress, turn end, verifier block) keeps working
 * through the bounded form, and a process of another agent is not reused.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { turnContext, type GraphReadScope } from '@omadia/orchestrator';
import {
  PROCESS_MEMORY_SERVICE_NAME,
  planNodeId,
  type KnowledgeGraph,
  type LlmCompleteResult,
  type PluginContext,
  type ProcessMemoryService,
  type ProcessRecord,
} from '@omadia/plugin-api';
import { activate } from '@omadia/plugin-plan-runner';

import { boundKnowledgeGraph, boundProcessMemory } from '../src/platform/boundedGraphServices.js';

const PLUGIN = '@omadia/plugin-plan-runner';
const STEPS = '[{"goal":"gather","dependsOn":[]},{"goal":"compute","dependsOn":[0]}]';

type Hook = (hookCtx: unknown, payload: unknown) => Promise<unknown>;

function processOf(id: string, scope: string): ProcessRecord {
  return { id, scope, title: `Ablauf: ${id}`, steps: ['eins', 'zwei'], version: 1, visibility: 'team' } as unknown as ProcessRecord;
}

async function planRunner(processes: readonly ProcessRecord[] = []) {
  const raw = new InMemoryKnowledgeGraph();
  const hooks = new Map<string, Hook>();
  const rawProcesses = {
    query: async () => processes.map((record) => ({ record, score: 0.99 })),
  } as unknown as ProcessMemoryService;
  const services: Record<string, unknown> = {
    turnHookRegistry: {
      register: (point: string, entry: { hook: Hook }) => {
        hooks.set(point, entry.hook);
        return () => undefined;
      },
    },
    knowledgeGraph: boundKnowledgeGraph(raw as unknown as KnowledgeGraph, PLUGIN),
    [PROCESS_MEMORY_SERVICE_NAME]: boundProcessMemory(rawProcesses, PLUGIN),
  };
  const config: Record<string, unknown> = { enabled: 'on', mapStepsAtTurnEnd: 'off' };
  const ctx = {
    log: () => undefined,
    config: { get: (key: string) => config[key] },
    services: { get: (name: string) => services[name] },
    llm: {
      complete: async (): Promise<LlmCompleteResult> =>
        ({ text: STEPS, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }) as unknown as LlmCompleteResult,
    },
  } as unknown as PluginContext;
  const handle = await activate(ctx);
  return { raw, hooks, handle };
}

function inTurn<T>(bound: GraphReadScope, fn: () => Promise<T>): Promise<T> {
  return turnContext.run(
    { turnId: 't-1', turnDate: '2026-11-25', agentSlug: 'atlas', sessionScope: 'web-1', graphReadScope: { value: bound } },
    fn,
  );
}

const hookCtx = { turnId: 't-1', agentSlug: 'atlas', sessionScope: 'web-1' };
const USER: GraphReadScope = { kind: 'user', userId: 'u-a', agentScopePrefix: 'atlas::', ownScope: 'atlas::web-1' };
const STRICT: GraphReadScope = { kind: 'conversation', scope: 'atlas::web-1' };

describe('ADR-0044 · the plan runner through the bounded graph services', () => {
  for (const [label, bound] of [
    ['off / enforce', USER],
    ['enforce-strict', STRICT],
  ] as const) {
    it(`${label}: plans, advances, finishes and records a verifier block on its own plan`, async () => {
      const { raw, hooks, handle } = await planRunner();
      await inTurn(bound, async () => {
        await hooks.get('onBeforeTurn')!(hookCtx, { userMessage: 'Bitte in Schritten', planHint: 'plan' });
        await hooks.get('onAfterToolCall')!(hookCtx, { toolName: 'query_odoo', toolResult: 'ok' });
        const annotation = await hooks.get('onAfterTurn')!(hookCtx, {
          turnExternalId: 'turn:atlas::web-1:1',
          assistantAnswer: 'Fertig.',
        });
        assert.ok(annotation, 'the final plan snapshot');
        await hooks.get('onVerifierBlocked')!(hookCtx, { blockReason: 'contradiction' });
      });
      const plan = await raw.getPlan(planNodeId('t-1'));
      assert.equal(plan?.props['scope'], 'atlas::web-1');
      const steps = await raw.getPlanSteps(planNodeId('t-1'));
      assert.equal(steps.length, 2);
      assert.equal(steps[0]!.props['status'], 'done');
      await handle.close();
    });
  }

  it('reuses this agent’s process, never another agent’s', async () => {
    const other = await planRunner([processOf('process:boreas::s:x', 'boreas::s')]);
    await inTurn(USER, () => other.hooks.get('onBeforeTurn')!(hookCtx, { userMessage: 'Ablauf', planHint: 'plan' }));
    assert.notEqual((await other.raw.getPlan(planNodeId('t-1')))?.props['createdBy'], 'process');

    const own = await planRunner([processOf('process:atlas::s:x', 'atlas::s')]);
    await inTurn(USER, () => own.hooks.get('onBeforeTurn')!(hookCtx, { userMessage: 'Ablauf', planHint: 'plan' }));
    assert.equal((await own.raw.getPlan(planNodeId('t-1')))?.props['createdBy'], 'process');
    await other.handle.close();
    await own.handle.close();
  });
});
