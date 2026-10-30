import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { LlmCompleteResult, PluginContext } from '@omadia/plugin-api';
import type { TurnHook, TurnHookPayload, TurnHookPoint } from '@omadia/orchestrator';
import { activate } from '@omadia/plugin-plan-runner';

// The fast-path triage classifies every chat turn before the orchestrator
// runs; on a `simple` verdict (one direct answer / one tool call) the
// plan-runner's `onBeforeTurn` used to spend two more Haiku calls — the gate
// and, when the gate said PLAN for an open question, a materialised plan the
// orchestrator then skipped step by step. Measured live: ~2.8 s on the
// critical path of a trivial turn. The hook now honours the verdict.

const THREE_STEPS =
  '[{"goal":"work out the period","dependsOn":[]},' +
  '{"goal":"fetch the open invoices","dependsOn":[0]},' +
  '{"goal":"present the invoices","dependsOn":[1]}]';

interface World {
  readonly beforeTurn: TurnHook;
  readonly llmCalls: number;
  readonly logs: string[];
  readonly kg: InMemoryKnowledgeGraph;
  close(): Promise<void>;
}

/** The real plugin on the in-memory graph; the LLM answers the gate with
 *  PLAN and the materialiser with three steps, counting every call. */
async function buildWorld(): Promise<World> {
  const hooks = new Map<TurnHookPoint, TurnHook>();
  const kg = new InMemoryKnowledgeGraph();
  const logs: string[] = [];
  const counter = { calls: 0 };
  const answers = ['PLAN', THREE_STEPS];
  const config: Record<string, unknown> = {
    enabled: 'on',
    gcDuplicatePlans: 'off',
    reuseProcesses: 'off',
  };
  const services: Record<string, unknown> = {
    turnHookRegistry: {
      register: (point: TurnHookPoint, reg: { hook: TurnHook }) => {
        hooks.set(point, reg.hook);
        return () => undefined;
      },
    },
    knowledgeGraph: kg,
  };
  const ctx = {
    log: (line: string) => logs.push(line),
    config: { get: (key: string) => config[key] },
    services: { get: (name: string) => services[name] },
    llm: {
      complete: async (): Promise<LlmCompleteResult> => ({
        text: answers[counter.calls++] ?? '',
        model: 'claude-haiku-4-5',
        inputTokens: 1,
        outputTokens: 1,
        finishReason: 'stop',
        stopReason: 'end_turn',
      }),
    },
  } as unknown as PluginContext;
  const handle = await activate(ctx);
  const beforeTurn = hooks.get('onBeforeTurn');
  assert.ok(beforeTurn, 'the plugin registered onBeforeTurn');
  return {
    beforeTurn,
    get llmCalls() {
      return counter.calls;
    },
    logs,
    kg,
    close: () => handle.close(),
  };
}

const hookCtx = { turnId: 'turn-route-hint', sessionScope: 'sess-route-hint' };
const payload = (extra: Partial<TurnHookPayload> = {}): TurnHookPayload => ({
  userMessage: 'Was geht morgen in Frankfurt ab?',
  ...extra,
});

describe('plan-runner onBeforeTurn × fast-path routeHint', () => {
  it('a `simple` verdict skips the gate and the materialiser — no model call, no plan', async () => {
    const w = await buildWorld();
    try {
      const annotations = await w.beforeTurn(hookCtx, payload({ routeHint: 'simple' }));
      assert.equal(w.llmCalls, 0, 'neither the gate nor the materialiser ran');
      assert.equal(annotations, undefined, 'no plan annotation for the stream');
      assert.ok(
        w.logs.includes('[plan-runner] skipped (fast-path routed simple)'),
        'the skip is logged',
      );
    } finally {
      await w.close();
    }
  });

  it('without a verdict the gate decides as before (PLAN → a materialised plan)', async () => {
    const w = await buildWorld();
    try {
      const annotations = await w.beforeTurn(hookCtx, payload());
      assert.equal(w.llmCalls, 2, 'gate + materialiser');
      assert.ok(Array.isArray(annotations) && annotations.length === 1, 'the plan annotation');
      assert.ok(
        w.logs.some((l) => l.includes('materialised') && l.includes('3 steps')),
        'three steps were materialised',
      );
    } finally {
      await w.close();
    }
  });

  it('a `complex` verdict still goes through the gate', async () => {
    const w = await buildWorld();
    try {
      await w.beforeTurn(hookCtx, payload({ routeHint: 'complex' }));
      assert.equal(w.llmCalls, 2, 'gate + materialiser');
    } finally {
      await w.close();
    }
  });
});
