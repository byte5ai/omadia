import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, type LlmCompleteResult, type PluginContext } from '@omadia/plugin-api';
import type { TurnHook, TurnHookPayload, TurnHookPoint } from '@omadia/orchestrator';
import { activate } from '@omadia/plugin-plan-runner';

// #1502 — the plan card marked steps `done` that never ran: every top-level
// tool call (memory, v4_render_answer included) advanced the cursor, a
// sub-agent whose calls all failed counted as success, and the turn's end
// closed the open step as `done`. These tests drive the real plugin through
// its turn hooks against the in-memory graph.

const TURN = 'turn-1502';

/** Answers the gate, the materializer and the replanner in call order. */
function scriptedLlm(texts: string[]) {
  let i = 0;
  return {
    complete: async (): Promise<LlmCompleteResult> => {
      if (i >= texts.length) throw new Error('llm down');
      return {
        text: texts[i++] ?? '',
        model: 'claude-haiku-4-5',
        inputTokens: 1,
        outputTokens: 1,
        finishReason: 'stop',
        stopReason: 'end_turn',
      };
    },
  };
}

const THREE_STEPS =
  '[{"goal":"work out the period","dependsOn":[]},' +
  '{"goal":"fetch the open invoices","dependsOn":[0]},' +
  '{"goal":"present the invoices","dependsOn":[1]}]';

async function runTurnKg(
  llmTexts: string[],
  calls: TurnHookPayload[],
): Promise<InMemoryKnowledgeGraph> {
  const hooks = new Map<TurnHookPoint, TurnHook>();
  const kg = new InMemoryKnowledgeGraph();
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
    log: () => undefined,
    config: { get: (key: string) => config[key] },
    services: { get: (name: string) => services[name] },
    llm: scriptedLlm(llmTexts),
  } as unknown as PluginContext;
  const handle = await activate(ctx);
  const hookCtx = { turnId: TURN, sessionScope: 'sess-1502' };
  await hooks.get('onBeforeTurn')!(hookCtx, {
    userMessage: 'Zeig mir die offenen Rechnungen des letzten Monats.',
  });
  for (const payload of calls) {
    // The real hook runner swallows a throwing hook; so does this harness.
    await Promise.resolve(hooks.get('onAfterToolCall')!(hookCtx, payload)).catch(() => undefined);
  }
  await hooks.get('onAfterTurn')!(hookCtx, { assistantAnswer: 'answer' });
  await handle.close();
  return kg;
}

async function runTurn(llmTexts: string[], calls: TurnHookPayload[]): Promise<unknown[]> {
  const kg = await runTurnKg(llmTexts, calls);
  const steps = await kg.getPlanSteps(planNodeId(TURN));
  return steps.map((s) => s.props['status']);
}

const memory: TurnHookPayload = {
  toolName: 'memory',
  toolResult: 'The path /memories does not exist.',
  toolFailed: false,
  toolIsBookkeeping: true,
};
const render: TurnHookPayload = {
  toolName: 'v4_render_answer',
  toolResult: 'rendered',
  toolFailed: false,
  toolIsBookkeeping: true,
};

describe('#1502 — plan steps are done only when a call did them', () => {
  it('a memory-only turn completes no step', async () => {
    const statuses = await runTurn(['PLAN', THREE_STEPS], [memory]);
    assert.deepEqual(statuses, ['skipped', 'skipped', 'skipped']);
  });

  it('bookkeeping calls neither advance nor complete a step', async () => {
    const statuses = await runTurn(
      ['PLAN', THREE_STEPS],
      [
        memory,
        {
          toolName: 'query_dataset',
          toolResult: '2 datasets',
          toolFailed: false,
          toolIsBookkeeping: false,
        },
        render,
      ],
    );
    assert.deepEqual(statuses, ['done', 'skipped', 'skipped']);
  });

  it('a sub-agent whose inner calls all failed fails its step, even with a prose result', async () => {
    const statuses = await runTurn(
      // gate, materializer, replanner (no recovery path)
      ['PLAN', THREE_STEPS, '[]'],
      [
        memory,
        {
          toolName: 'query_confluence',
          toolResult: 'I could not access the Confluence space.',
          toolFailed: true,
          toolIsBookkeeping: false,
        },
      ],
    );
    assert.deepEqual(statuses, ['failed', 'skipped', 'skipped']);
  });

  it('the answer completes the last step when every step before it ran', async () => {
    const work = (name: string): TurnHookPayload => ({
      toolName: name,
      toolResult: 'ok',
      toolFailed: false,
      toolIsBookkeeping: false,
    });
    const statuses = await runTurn(
      ['PLAN', THREE_STEPS],
      [memory, work('query_calendar'), work('query_odoo_accounting'), render],
    );
    assert.deepEqual(statuses, ['done', 'done', 'done']);
  });

  it('a replan that throws after marking the step failed keeps it failed', async () => {
    const statuses = await runTurn(
      // gate, materializer — the replanner's model call then throws
      ['PLAN', THREE_STEPS],
      [
        {
          toolName: 'query_odoo',
          toolResult: 'Error: odoo_upstream_401',
          toolFailed: true,
          toolIsBookkeeping: false,
        },
      ],
    );
    assert.deepEqual(statuses, ['failed', 'skipped', 'skipped']);
  });

  it('records evidence even when the call had no string result', async () => {
    const kg = await runTurnKg(['PLAN', THREE_STEPS], [{ toolName: 'query_odoo', toolFailed: false }]);
    const steps = await kg.getPlanSteps(planNodeId(TURN));
    assert.equal(steps[0]!.props['resultSummary'], 'query_odoo');
  });

  it('falls back to the `Error:` convention when the kernel sends no toolFailed', async () => {
    const statuses = await runTurn(
      ['PLAN', THREE_STEPS, '[]'],
      [{ toolName: 'query_odoo', toolResult: 'Error: odoo_upstream_401' }],
    );
    assert.deepEqual(statuses, ['failed', 'skipped', 'skipped']);
  });
});
