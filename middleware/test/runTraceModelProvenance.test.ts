/**
 * Issue #650 (epic #642) — the persisted `RunTrace` records WHICH MODEL
 * produced the answer.
 *
 * The trace held how long a turn ran, which sub-agents ran and which tools were
 * called — but not the one fact a provenance question about a past turn starts
 * from. The model id already existed in the system (on the `done` event, in the
 * cost telemetry); it simply never reached the persisted record.
 *
 * ## The migration the issue asked for is not needed
 *
 * #650's acceptance criteria call for a schema migration. That premise does not
 * hold for this table: `graph_nodes.properties` is a generic `JSONB` column
 * (`0001_graph_init.sql`) and `RunPropsSchema` is `.passthrough()`, so adding a
 * property is a schema-level change only. The tests below pin the two things a
 * migration would have been FOR — new traces carry the fields, and traces
 * written before they existed stay readable — which is the actual requirement.
 *
 * Imported from SOURCE, not the built barrels, so a mutation in `src/` cannot
 * report green over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { RunTraceCollector } from '../packages/harness-orchestrator/src/runTraceCollector.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { NodePropsSchemaByType } from '../packages/harness-knowledge-graph-neon/src/schema.js';
import type { RunTrace } from '../packages/plugin-api/src/knowledgeGraph.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const PROVIDER = 'anthropic';

function baseTrace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    turnId: 'turn-650',
    scope: 'sess-650',
    startedAt: '2026-08-13T10:00:00.000Z',
    finishedAt: '2026-08-13T10:00:02.000Z',
    durationMs: 2000,
    status: 'success',
    iterations: 1,
    orchestratorToolCalls: [],
    agentInvocations: [],
    ...over,
  };
}

describe('#650 — the collector carries the model onto the trace', () => {
  it('MUTATION CHECK: a recorded model reaches the finished payload', () => {
    const collector = new RunTraceCollector({ scope: 'sess-650' });
    collector.recordModel(MODEL, PROVIDER);
    const payload = collector.finish({ iterations: 2, status: 'success' });

    assert.equal(payload.model, MODEL);
    assert.equal(payload.provider, PROVIDER);
  });

  it('MUTATION CHECK: an unrecorded model is OMITTED, never an empty string', () => {
    // A trace carrying `model: ''` claims to know and does not. Absence is the
    // honest encoding, and it is what keeps the field meaningful.
    const payload = new RunTraceCollector({ scope: 'sess-650' }).finish({
      iterations: 1,
      status: 'success',
    });
    assert.equal('model' in payload, false);
    assert.equal('provider' in payload, false);
  });

  it('MUTATION CHECK: the last routing decision wins', () => {
    // A turn that re-routes mid-flight must report the model that ANSWERED,
    // not the one it started with.
    const collector = new RunTraceCollector({ scope: 'sess-650' });
    collector.recordModel('claude-haiku-4-5-20251001', PROVIDER);
    collector.recordModel(MODEL, PROVIDER);
    assert.equal(collector.finish({ iterations: 1, status: 'success' }).model, MODEL);
  });

  it('records the model without a provider when none is known', () => {
    const collector = new RunTraceCollector({ scope: 'sess-650' });
    collector.recordModel(MODEL);
    const payload = collector.finish({ iterations: 1, status: 'success' });
    assert.equal(payload.model, MODEL);
    assert.equal('provider' in payload, false);
  });
});

/**
 * Ingests a real Turn first, then the Run for it, and reads the Run back
 * through the public `getRunForTurn`. Going through the real read path rather
 * than poking at internals is what makes this a test of the STORED record: a
 * field written into a node nobody can retrieve is not persisted provenance.
 */
async function storeRun(
  over: Partial<RunTrace>,
): Promise<Record<string, unknown>> {
  const graph = new InMemoryKnowledgeGraph();
  const { turnId } = await graph.ingestTurn({
    scope: 'sess-650',
    time: '2026-08-13T10:00:02.000Z',
    userMessage: 'wer hat das geschrieben?',
    assistantAnswer: 'ich',
    entityRefs: [],
  });
  await graph.ingestRun(baseTrace({ ...over, turnId }));
  const view = await graph.getRunForTurn(turnId);
  assert.ok(view, 'the Run node was not retrievable for its Turn');
  return view.run.props;
}

describe('#650 — both knowledge-graph backends agree', () => {
  it('MUTATION CHECK: the in-memory graph persists model and provider on the Run node', async () => {
    const props = await storeRun({ model: MODEL, provider: PROVIDER });
    assert.equal(props['model'], MODEL);
    assert.equal(props['provider'], PROVIDER);
  });

  it('MUTATION CHECK: a trace without the fields writes no empty keys', async () => {
    // "Existing traces stay readable" is an acceptance criterion. Writing
    // `model: undefined` would satisfy the type and corrupt the record.
    const props = await storeRun({});
    assert.equal('model' in props, false);
    assert.equal('provider' in props, false);
  });
});

describe('#650 — the Neon Run schema accepts both shapes', () => {
  const schema = NodePropsSchemaByType['Run'];

  const stored = {
    turnId: 'turn-650',
    scope: 'sess-650',
    startedAt: '2026-08-13T10:00:00.000Z',
    finishedAt: '2026-08-13T10:00:02.000Z',
    durationMs: 2000,
    status: 'success' as const,
    iterations: 1,
    toolCalls: 0,
  };

  it('MUTATION CHECK: a Run WITH model and provider validates', () => {
    assert.ok(schema, 'no Run schema registered');
    const parsed = schema.safeParse({ ...stored, model: MODEL, provider: PROVIDER });
    assert.equal(parsed.success, true, JSON.stringify(parsed));
  });

  it('MUTATION CHECK: a Run WITHOUT them still validates — old rows stay readable', () => {
    // This is what the issue's requested migration would have existed to
    // guarantee. Optional fields on a JSONB column give it for free.
    assert.ok(schema);
    assert.equal(schema.safeParse(stored).success, true);
  });

  it('rejects a non-string model rather than storing it', () => {
    assert.ok(schema);
    assert.equal(schema.safeParse({ ...stored, model: 42 }).success, false);
  });
});
