import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  PLAN_STEP_ANSWER_EVIDENCE,
  isEvidencedPlanStepDone,
  planNodeId,
  type LlmCompleteResult,
  type PluginContext,
} from '@omadia/plugin-api';
import type { TurnAnnotation, TurnHook, TurnHookPayload, TurnHookPoint } from '@omadia/orchestrator';
import { activate } from '@omadia/plugin-plan-runner';

import { parseStepMapping } from '../packages/harness-plugin-plan-runner/src/stepMapper.js';

// #1502 follow-up, option C (Marcel, 2026-10-29) — one Haiku pass at turn end
// maps the whole tool trace to the plan steps, for the stored record and
// recall. The live card keeps the sequential heuristic; a failed judge keeps
// the heuristic record. Driven through the real plugin hooks against the
// in-memory graph, like planRunnerStepOutcome1502.test.ts.

const TURN = 'turn-map';

function scriptedLlm(texts: string[]) {
  let i = 0;
  const requests: unknown[] = [];
  return {
    calls: () => i,
    requests,
    complete: async (req: unknown): Promise<LlmCompleteResult> => {
      requests.push(req);
      if (i >= texts.length) {
        i += 1;
        throw new Error('llm down');
      }
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

/** One call that fetched the invoices for last month: it serves steps 1 and 2. */
const ONE_CALL: TurnHookPayload = {
  toolName: 'query_odoo',
  toolResult: '12 open invoices for 2026-09',
  toolFailed: false,
  toolIsBookkeeping: false,
};

async function runTurn(
  llmTexts: string[],
  calls: TurnHookPayload[],
  config: Record<string, unknown> = {},
): Promise<{
  kg: InMemoryKnowledgeGraph;
  live: unknown;
  llmCalls: () => number;
  requests: unknown[];
  logs: string[];
}> {
  const hooks = new Map<TurnHookPoint, TurnHook>();
  const kg = new InMemoryKnowledgeGraph();
  const cfg: Record<string, unknown> = {
    enabled: 'on',
    gcDuplicatePlans: 'off',
    reuseProcesses: 'off',
    ...config,
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
  const llm = scriptedLlm(llmTexts);
  const logs: string[] = [];
  const ctx = {
    log: (msg: string) => logs.push(msg),
    config: { get: (key: string) => cfg[key] },
    services: { get: (name: string) => services[name] },
    llm,
  } as unknown as PluginContext;
  const handle = await activate(ctx);
  const hookCtx = { turnId: TURN, sessionScope: 'sess-map' };
  await hooks.get('onBeforeTurn')!(hookCtx, { userMessage: 'Offene Rechnungen letzter Monat?' });
  for (const payload of calls) {
    await hooks.get('onAfterToolCall')!(hookCtx, payload);
  }
  const annotations = (await hooks.get('onAfterTurn')!(hookCtx, {
    assistantAnswer: 'Hier sind die 12 offenen Rechnungen.',
  })) as TurnAnnotation[] | undefined;
  // The mapping runs after the hook returned; let it settle.
  for (let i = 0; i < 20 && !logs.some((l) => l.includes('step mapping')); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await handle.close();
  const live = (annotations?.[0]?.payload as { steps: Array<{ status: string }> } | undefined)?.steps.map(
    (s) => s.status,
  );
  return { kg, live, llmCalls: llm.calls, requests: llm.requests, logs };
}

async function stored(kg: InMemoryKnowledgeGraph) {
  const steps = await kg.getPlanSteps(planNodeId(TURN));
  return steps
    .sort((a, b) => Number(a.props['order']) - Number(b.props['order']))
    .map((s) => s.props);
}

describe('#1502 option C — turn-end step mapping', () => {
  it('corrects the stored record; the live card keeps the heuristic', async () => {
    const mapping =
      '{"steps":[{"step":1,"calls":[1],"answer":false},' +
      '{"step":2,"calls":[1],"answer":false},{"step":3,"calls":[],"answer":true}]}';
    const { kg, live } = await runTurn(['PLAN', THREE_STEPS, mapping], [ONE_CALL]);

    // Heuristic: one call → first step done, the rest not reached.
    assert.deepEqual(live, ['done', 'skipped', 'skipped']);
    const props = await stored(kg);
    assert.deepEqual(
      props.map((p) => p['status']),
      ['done', 'done', 'done'],
    );
    assert.equal(props[1]?.['resultSummary'], 'query_odoo: 12 open invoices for 2026-09');
    assert.equal(props[2]?.['resultSummary'], PLAN_STEP_ANSWER_EVIDENCE);
    // Recall trusts all three.
    assert.ok(props.every((p) => isEvidencedPlanStepDone(p)));
  });

  it('sends tool names only: no tool result and no answer text', async () => {
    const mapping =
      '{"steps":[{"step":1,"calls":[1]},{"step":2,"calls":[1]},{"step":3,"answer":true}]}';
    const { requests } = await runTurn(['PLAN', THREE_STEPS, mapping], [ONE_CALL]);
    const judge = JSON.stringify(requests[2]);
    assert.match(judge, /query_odoo/);
    assert.match(judge, /fetch the open invoices/);
    // The result may hold real values whatever the shield posture, and the
    // answer carries the values the shield restored; ctx.llm masks nothing.
    assert.doesNotMatch(judge, /12 open invoices/);
    assert.doesNotMatch(judge, /Hier sind die 12 offenen Rechnungen/);
  });

  it('un-credits a step the call did not serve', async () => {
    const listCall: TurnHookPayload = {
      toolName: 'query_dataset',
      toolResult: '2 datasets',
      toolFailed: false,
      toolIsBookkeeping: false,
    };
    const mapping =
      '{"steps":[{"step":1,"calls":[],"answer":false},' +
      '{"step":2,"calls":[],"answer":false},{"step":3,"calls":[],"answer":false}]}';
    const { kg, live } = await runTurn(['PLAN', THREE_STEPS, mapping], [listCall]);

    assert.deepEqual(live, ['done', 'skipped', 'skipped']);
    assert.deepEqual(
      (await stored(kg)).map((p) => p['status']),
      ['skipped', 'skipped', 'skipped'],
    );
  });

  it('keeps the heuristic record when the judge fails', async () => {
    const { kg, logs } = await runTurn(['PLAN', THREE_STEPS], [ONE_CALL]);
    assert.deepEqual(
      (await stored(kg)).map((p) => p['status']),
      ['done', 'skipped', 'skipped'],
    );
    assert.ok(logs.some((l) => l.includes('kept the in-turn mapping')));
  });

  it('keeps the heuristic record when the judge answers nonsense', async () => {
    const { kg } = await runTurn(['PLAN', THREE_STEPS, '{"steps":[{"step":9,"calls":[1]}]}'], [ONE_CALL]);
    assert.deepEqual(
      (await stored(kg)).map((p) => p['status']),
      ['done', 'skipped', 'skipped'],
    );
  });

  it('makes no call when switched off or when the turn ran no work call', async () => {
    const off = await runTurn(['PLAN', THREE_STEPS], [ONE_CALL], { mapStepsAtTurnEnd: 'off' });
    assert.equal(off.llmCalls(), 2, 'gate + materializer only');
    const idle = await runTurn(['PLAN', THREE_STEPS], []);
    assert.equal(idle.llmCalls(), 2);
  });
});

describe('parseStepMapping', () => {
  it('accepts a complete verdict, fenced or not', () => {
    const raw = '```json\n{"steps":[{"step":1,"calls":[2]},{"step":2,"calls":[],"answer":true}]}\n```';
    assert.deepEqual(parseStepMapping(raw, 2, 2), [
      { calls: [1], answer: false },
      { calls: [], answer: true },
    ]);
  });

  it('rejects missing steps and out-of-range calls as a whole', () => {
    assert.equal(parseStepMapping('{"steps":[{"step":1,"calls":[]}]}', 2, 1), undefined);
    assert.equal(parseStepMapping('{"steps":[{"step":1,"calls":[3]}]}', 1, 2), undefined);
    assert.equal(parseStepMapping('not json', 1, 1), undefined);
  });
});
