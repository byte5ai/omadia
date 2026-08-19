/**
 * #584 — Source/Billed Minutes are VISIBLE on the run trace's
 * tool-call record (`RunToolCall.usage`), end to end: the collector copies
 * the observer event onto the trace (the #130 postcondition route), both
 * knowledge-graph backends persist the field the same way, and the Neon zod
 * schema declares it explicitly (a tolerated-only passthrough field is an
 * undocumented field — #650 precedent).
 *
 * The trace is best-effort by contract: nothing here is load-bearing for
 * billing or quota — the `transcription_usage` table is truth
 * (transcriptionUsageTelemetry.test.ts). Trace = visibility.
 *
 * Imported from SOURCE, not the built barrels, so a mutation in `src/`
 * cannot report green over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { RunTraceCollector } from '../packages/harness-orchestrator/src/runTraceCollector.js';
import { toolUsage } from '../packages/harness-orchestrator/src/toolUsageContext.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { NodePropsSchemaByType } from '../packages/harness-knowledge-graph-neon/src/schema.js';
import type { RunTrace } from '../packages/plugin-api/src/knowledgeGraph.js';

const USAGE = { sourceMinutes: 12.5, billedMinutes: 25 };

function baseTrace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    turnId: 'turn-584',
    scope: 'sess-584',
    startedAt: '2026-08-19T10:00:00.000Z',
    finishedAt: '2026-08-19T10:00:02.000Z',
    durationMs: 2000,
    status: 'success',
    iterations: 1,
    orchestratorToolCalls: [],
    agentInvocations: [],
    ...over,
  };
}

describe('#584 — the collector carries tool-call usage onto the trace', () => {
  it('MUTATION CHECK: a sub-tool result with usage lands on RunToolCall.usage', () => {
    // Also the first pin on the #130 copy line itself (runTraceCollector.ts,
    // onSubToolResult): postcondition had no collector-level test either.
    const collector = new RunTraceCollector({ scope: 'sess-584' });
    const inv = collector.beginInvocation('transcription-agent');
    inv.observer.onSubToolUse?.({ id: 'call-1', name: 'transcribe_recording', input: {} });
    inv.observer.onSubToolResult?.({
      id: 'call-1',
      output: 'Aufnahme transkribiert.',
      durationMs: 1200,
      isError: false,
      usage: USAGE,
    });
    inv.finish({ durationMs: 1200, status: 'success' });
    const payload = collector.finish({ iterations: 1, status: 'success' });

    assert.deepEqual(payload.agentInvocations[0]?.toolCalls[0]?.usage, USAGE);
  });

  it('MUTATION CHECK: a result without usage yields NO usage key — absence is the honest encoding', () => {
    const collector = new RunTraceCollector({ scope: 'sess-584' });
    const inv = collector.beginInvocation('transcription-agent');
    inv.observer.onSubToolResult?.({
      id: 'call-1',
      output: 'ok',
      durationMs: 5,
      isError: false,
    });
    inv.finish({ durationMs: 5, status: 'success' });
    const call = collector
      .finish({ iterations: 1, status: 'success' })
      .agentInvocations[0]?.toolCalls[0];
    assert.ok(call);
    assert.equal('usage' in call, false);
  });

  it('a native (orchestrator-level) tool call records usage via recordOrchestratorToolCall', () => {
    // transcribe_recording IS a native tool: its usage reaches the collector
    // through the per-dispatch `toolUsageSink` box, stamped by the call site.
    const collector = new RunTraceCollector({ scope: 'sess-584' });
    collector.recordOrchestratorToolCall({
      callId: 'toolu_1',
      toolName: 'transcribe_recording',
      durationMs: 900,
      isError: false,
      usage: USAGE,
    });
    const payload = collector.finish({ iterations: 1, status: 'success' });
    assert.deepEqual(payload.orchestratorToolCalls[0]?.usage, USAGE);
  });
});

describe('#584 — the native-tool side-channel (toolUsageContext)', () => {
  it('MUTATION CHECK: a report inside a capture scope lands in that scope`s box', async () => {
    const box: { value?: typeof USAGE } = {};
    await toolUsage.capture(box, async () => {
      toolUsage.report(USAGE);
    });
    assert.deepEqual(box.value, USAGE);
  });

  it('a report outside any capture scope is a silent no-op (trace-only loss)', () => {
    toolUsage.report(USAGE); // must not throw
  });

  it('MUTATION CHECK: concurrent captures cannot see each other`s box', async () => {
    // Two native dispatches in one `allSettled` batch — the reason the sink
    // is an AsyncLocalStorage scope and not a shared turn-context field.
    const boxA: { value?: typeof USAGE } = {};
    const boxB: { value?: typeof USAGE } = {};
    const usageB = { sourceMinutes: 1, billedMinutes: 3 };
    await Promise.all([
      toolUsage.capture(boxA, async () => {
        await new Promise((r) => setTimeout(r, 5));
        toolUsage.report(USAGE);
      }),
      toolUsage.capture(boxB, async () => {
        toolUsage.report(usageB);
        await new Promise((r) => setTimeout(r, 10));
      }),
    ]);
    assert.deepEqual(boxA.value, USAGE);
    assert.deepEqual(boxB.value, usageB);
  });
});

/** Ingest a Turn + Run, read the ToolCall back through the public view. */
async function storeToolCalls(
  over: Partial<RunTrace>,
): Promise<{
  orchestrator: Array<Record<string, unknown>>;
  subAgent: Array<Record<string, unknown>>;
}> {
  const graph = new InMemoryKnowledgeGraph();
  const { turnId } = await graph.ingestTurn({
    scope: 'sess-584',
    time: '2026-08-19T10:00:02.000Z',
    userMessage: 'transkribiere die aufnahme',
    assistantAnswer: 'erledigt',
    entityRefs: [],
  });
  await graph.ingestRun(baseTrace({ ...over, turnId }));
  const view = await graph.getRunForTurn(turnId);
  assert.ok(view, 'the Run node was not retrievable for its Turn');
  return {
    orchestrator: view.orchestratorToolCalls.map((tc) => tc.node.props),
    subAgent: view.agentInvocations.flatMap((inv) =>
      inv.toolCalls.map((tc) => tc.node.props),
    ),
  };
}

describe('#584 — the in-memory graph persists tool-call usage (Neon twin below)', () => {
  it('MUTATION CHECK: usage survives on orchestrator AND sub-agent tool calls', async () => {
    const { orchestrator, subAgent } = await storeToolCalls({
      orchestratorToolCalls: [
        {
          callId: 'toolu_1',
          toolName: 'transcribe_recording',
          durationMs: 900,
          isError: false,
          agentContext: 'orchestrator',
          usage: USAGE,
        },
      ],
      agentInvocations: [
        {
          index: 0,
          agentName: 'transcription-agent',
          durationMs: 1000,
          subIterations: 1,
          status: 'success',
          toolCalls: [
            {
              callId: 'call-1',
              toolName: 'transcribe_recording',
              durationMs: 800,
              isError: false,
              agentContext: 'transcription-agent',
              usage: USAGE,
            },
          ],
        },
      ],
    });
    assert.deepEqual(orchestrator[0]?.['usage'], USAGE);
    assert.deepEqual(subAgent[0]?.['usage'], USAGE);
  });

  it('MUTATION CHECK: a call without usage writes no empty key — old traces stay readable', async () => {
    const { orchestrator } = await storeToolCalls({
      orchestratorToolCalls: [
        {
          callId: 'toolu_1',
          toolName: 'memory_search',
          durationMs: 10,
          isError: false,
          agentContext: 'orchestrator',
        },
      ],
    });
    assert.ok(orchestrator[0]);
    assert.equal('usage' in orchestrator[0], false);
  });
});

describe('#584 — the Neon ToolCall schema accepts both shapes', () => {
  const schema = NodePropsSchemaByType['ToolCall'];

  const stored = {
    runId: 'run:turn-584',
    toolName: 'transcribe_recording',
    durationMs: 900,
    isError: false,
    agentContext: 'orchestrator',
  };

  it('MUTATION CHECK: a ToolCall WITH usage validates', () => {
    assert.ok(schema, 'no ToolCall schema registered');
    const parsed = schema.safeParse({ ...stored, usage: USAGE });
    assert.equal(parsed.success, true, JSON.stringify(parsed));
  });

  it('MUTATION CHECK: a ToolCall WITHOUT usage still validates — old rows stay readable', () => {
    assert.ok(schema);
    assert.equal(schema.safeParse(stored).success, true);
  });

  it('rejects negative minutes rather than storing them', () => {
    assert.ok(schema);
    assert.equal(
      schema.safeParse({
        ...stored,
        usage: { sourceMinutes: -1, billedMinutes: 2 },
      }).success,
      false,
    );
  });

  it('rejects a malformed usage object rather than storing it', () => {
    assert.ok(schema);
    assert.equal(
      schema.safeParse({ ...stored, usage: { sourceMinutes: 'viele' } }).success,
      false,
    );
  });
});
