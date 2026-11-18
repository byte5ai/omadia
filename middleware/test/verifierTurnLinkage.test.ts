import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { EntityRefBus, type EntityRef } from '@omadia/plugin-api';
import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import type { VerifierVerdict } from '@omadia/verifier';
import {
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  runWithUsageContext,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/chatAgent.js';
import {
  RunTraceCollector,
  SharedEntityRefs,
  turnEvidenceOf,
} from '../packages/harness-orchestrator/src/runTraceCollector.js';
import { createVerifierHarness, USER_INPUT } from './_helpers/verifierServiceHarness.js';

/**
 * #1571 — a verdict, its contradictions, its log lines and the verifier's
 * token usage can be joined to the turn they checked. #1574 — the records the
 * turn's tools read reach the pipeline. #1576 — `shadow` logs the diagnosis
 * `enforce` would log.
 */

function collection(refs: EntityRef[]): { drain(): EntityRef[]; drains: number } {
  const state = {
    drains: 0,
    drain(): EntityRef[] {
      state.drains += 1;
      return state.drains === 1 ? [...refs] : [];
    },
  };
  return state;
}

const REFS: EntityRef[] = [
  { system: 'odoo', model: 'hr.employee', id: 15, displayName: 'Anna Müller', op: 'read' },
  { system: 'odoo', model: 'hr.leave', id: '101', op: 'read' },
  { system: 'confluence', model: 'confluence.page', id: 9, op: 'read' },
];

function tracedDone(turnId: string): Extract<ChatStreamEvent, { type: 'done' }> {
  const shared = new SharedEntityRefs(collection(REFS));
  const collector = new RunTraceCollector({ scope: 'scope-1', turnId, entityRefs: shared });
  const runTrace = collector.finish({ iterations: 1, status: 'success' });
  return {
    type: 'done',
    answer: 'Anna Müller hat 9 Urlaubstage.',
    toolCalls: 1,
    iterations: 1,
    runTrace,
  } as Extract<ChatStreamEvent, { type: 'done' }>;
}

const UNCONFIRMED: VerifierVerdict = {
  status: 'approved_with_disclaimer',
  claims: [
    { status: 'unverified', claim: { id: 'c_001', text: '9', type: 'aggregate', expectedSource: 'odoo', relatedEntities: [] }, reason: 'x' },
  ],
  unverified: [
    { status: 'unverified', claim: { id: 'c_001', text: '9', type: 'aggregate', expectedSource: 'odoo', relatedEntities: [] }, reason: 'x' },
  ],
  latencyMs: 1,
} as VerifierVerdict;

describe('SharedEntityRefs / turnEvidenceOf', () => {
  it('lets the trace and the session log read the same refs from one bus collection', () => {
    const source = collection(REFS);
    const shared = new SharedEntityRefs(source);
    const collector = new RunTraceCollector({ scope: 's', turnId: 't-1', entityRefs: shared });
    const trace = collector.finish({ iterations: 0, status: 'success' });
    assert.deepEqual(turnEvidenceOf(trace), { turnId: 't-1', entityRefs: REFS });
    assert.deepEqual(shared.drain(), REFS, 'the session log still gets every ref');
    assert.deepEqual(shared.drain(), [], 'drained once, like the bus');
    assert.equal(source.drains, 1);
  });

  it('keeps the evidence off the payload', () => {
    const trace = new RunTraceCollector({ scope: 's', turnId: 't-2' }).finish({
      iterations: 0,
      status: 'success',
    });
    assert.equal(JSON.stringify(trace).includes('t-2'), false);
  });
});

describe('#1571 / #1574 / #1576 — the verifier knows the turn it checks', () => {
  it('shadow: passes the turn records, stores the turn id and agent, logs the diagnosis', async () => {
    const h = createVerifierHarness({
      mode: 'shadow',
      streams: [[tracedDone('turn-abc')]],
      verdicts: [UNCONFIRMED],
    });
    await h.stream(USER_INPUT);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(h.verifyInputs[0]?.turnRecords, [
      { model: 'hr.employee', id: 15 },
      { model: 'hr.leave', id: 101 },
    ]);
    assert.deepEqual(h.persistedIds, [{ runId: 'turn-abc', agent: 'default' }]);
    const line = h.logs.find((l) => l.startsWith('[verifier/service] shadow verdict'));
    assert.ok(line, h.logs.join('\n'));
    assert.match(line, /turn=turn-abc/);
    assert.match(line, /enforce=release_unconfirmed/);
    assert.match(line, /status=approved_with_disclaimer/);
    assert.match(line, /claims=c_001:unverified/);
  });

  it('shadow: names a verdict enforce would withhold', async () => {
    const blocked: VerifierVerdict = {
      status: 'blocked',
      claims: [
        { status: 'contradicted', claim: { id: 'c_002', text: '9', type: 'aggregate', expectedSource: 'odoo', relatedEntities: [] }, truth: 14, source: 'odoo' },
      ],
      contradictions: [
        { status: 'contradicted', claim: { id: 'c_002', text: '9', type: 'aggregate', expectedSource: 'odoo', relatedEntities: [] }, truth: 14, source: 'odoo' },
      ],
      latencyMs: 1,
    } as VerifierVerdict;
    const h = createVerifierHarness({ mode: 'shadow', streams: [[tracedDone('turn-def')]], verdicts: [blocked] });
    await h.stream(USER_INPUT);
    const line = h.logs.find((l) => l.startsWith('[verifier/service] shadow verdict'));
    assert.match(line ?? '', /enforce=withhold/);
  });

  it('enforce: log lines and the stored row carry the request\'s turn id', async () => {
    const h = createVerifierHarness({
      mode: 'enforce',
      streams: [[tracedDone('turn-ghi')]],
      verdicts: [UNCONFIRMED],
    });
    await h.stream(USER_INPUT);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.persistedIds, [{ runId: 'turn-ghi', agent: 'default' }]);
    assert.ok(
      h.logs.some((l) => l.includes('answer released unconfirmed') && l.includes('turn=turn-ghi')),
      h.logs.join('\n'),
    );
  });
});

describe('#1571 — runWithUsageContext attributes rows written after the turn closed', () => {
  it('wins over the registered provider; explicit ids still win over it', async () => {
    const captured: Array<{ params: readonly unknown[] }> = [];
    initUsageRecorder({
      query: (_sql: string, params: readonly unknown[]) => {
        captured.push({ params });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool);
    setUsageContextProvider(() => undefined);
    const row = {
      source: 'verifier',
      model: 'claude-haiku-4-5',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    await runWithUsageContext({ turnId: 'turn-1', sessionId: 'sess-1' }, async () => {
      await Promise.resolve();
      recordUsage(row);
      recordUsage({ ...row, turnId: 'explicit' });
    });
    recordUsage(row);
    await flushUsageRecorder();
    setUsageContextProvider(undefined);
    const params = captured.flatMap((q) => q.params);
    const TURN_ID = 10;
    const COLS = 13;
    assert.equal(params[TURN_ID], 'turn-1');
    assert.equal(params[COLS + TURN_ID], 'explicit');
    assert.equal(params[2 * COLS + TURN_ID] ?? null, null, 'outside the scope: no turn');
  });
});

describe('#1571 / #1574 — the turn evidence survives the real orchestrator paths', () => {
  const response = {
    content: [{ type: 'text', text: 'Antwort.' }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as unknown as LlmResponse;
  const provider = {
    id: 'anthropic',
    capabilities: { tools: true, vision: true, streaming: true, promptCaching: true, forcedToolChoice: true, parallelToolCalls: true },
    complete: async () => response,
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text: 'Antwort.' };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
  const make = (): Orchestrator =>
    new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 256,
      maxToolIterations: 2,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      entityRefBus: new EntityRefBus(),
    });

  it('runTurn: the result\'s trace carries the turn id beside it', async () => {
    const result = await make().runTurn({ userMessage: 'hi', sessionScope: 'scope-e2e' });
    assert.ok(result.runTrace, 'trace present');
    const evidence = turnEvidenceOf(result.runTrace);
    assert.ok(evidence?.turnId, 'turn id kept beside the very trace object the verifier reads');
    assert.deepEqual(evidence?.entityRefs, []);
  });

  it('chatStream: the done event\'s trace carries it too', async () => {
    let trace: unknown;
    for await (const ev of make().chatStream({ userMessage: 'hi', sessionScope: 'scope-e2e-s' })) {
      if (ev.type === 'done') trace = ev.runTrace;
    }
    assert.ok(trace);
    assert.ok(turnEvidenceOf(trace as Parameters<typeof turnEvidenceOf>[0])?.turnId);
  });
});
