/**
 * #130 native-tool extension — RunTraceCollector must accept a
 * postcondition marker on `recordOrchestratorToolCall` and propagate it
 * to the finalised RunTracePayload so the verifier picks it up via the
 * same path as sub-agent tool postconditions.
 *
 * The wiring up to this point (NativeToolHandler return-union,
 * dispatchToolInner unwrap, slot-loop propagation, finishSlotInvocation
 * stamping) is enforced by the TypeScript compiler. This test covers the
 * one runtime hand-off — collector accepts and stores the marker — that
 * the type system can't catch.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { RunTraceCollector } from '../packages/harness-orchestrator/src/runTraceCollector.js';

describe('RunTraceCollector — orchestrator-tool postcondition (#130 native)', () => {
  it('persists postcondition on orchestratorToolCalls', () => {
    const collector = new RunTraceCollector({
      scope: 'test',
      startedAt: '2026-05-28T12:00:00.000Z',
    });

    collector.recordOrchestratorToolCall({
      callId: 'call_native_a',
      toolName: 'calc_sum',
      durationMs: 4,
      isError: true,
      postcondition: {
        issues: ['<root>: expected number, received string'],
      },
    });

    const payload = collector.finish({
      iterations: 1,
      status: 'error',
      finishedAt: '2026-05-28T12:00:00.500Z',
    });

    assert.equal(payload.orchestratorToolCalls.length, 1);
    const call = payload.orchestratorToolCalls[0]!;
    assert.equal(call.callId, 'call_native_a');
    assert.equal(call.toolName, 'calc_sum');
    assert.equal(call.isError, true);
    assert.deepEqual(call.postcondition, {
      issues: ['<root>: expected number, received string'],
    });
  });

  it('omits postcondition when the native tool returned cleanly', () => {
    const collector = new RunTraceCollector({
      scope: 'test',
      startedAt: '2026-05-28T12:00:00.000Z',
    });

    collector.recordOrchestratorToolCall({
      callId: 'call_native_b',
      toolName: 'calc_sum',
      durationMs: 2,
      isError: false,
    });

    const payload = collector.finish({
      iterations: 1,
      status: 'success',
      finishedAt: '2026-05-28T12:00:00.200Z',
    });

    const call = payload.orchestratorToolCalls[0]!;
    assert.equal(call.postcondition, undefined);
  });
});
