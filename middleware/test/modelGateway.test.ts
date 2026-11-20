/**
 * Spec 2042 §5.10, ADR-0017 — the model gateway's gate.
 *
 * Every model call runs in exactly one execution context; a call outside any
 * is refused in `enforce` and recorded in `observe`; a maintenance run only
 * embeds; deadlines, cancels and kill switches refuse; the agent runtime's
 * turn scope is an agent turn; embedding and transcription services pass the
 * gate like text generation.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { admitModelCall, isModelCallNotCovered, type ModelOperation } from '@omadia/llm-provider';
import {
  currentExecutionContext,
  meterModelCalls,
  resetModelGatewayForTests,
  runGeneratorInExecutionContext,
  runInExecutionContext,
  setAmbientExecutionContext,
  setModelCallHalts,
  setModelGatewayMode,
  uncoveredModelCalls,
  type ModelExecutionContext,
} from '@omadia/usage-telemetry';

import { gateModelService } from '../src/platform/modelGatewayServices.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const turn: ModelExecutionContext = { kind: 'agent_turn', ownerId: 'mira', agentSlug: 'mira' };
const maintenance: ModelExecutionContext = { kind: 'maintenance_run', ownerId: 'run-1', operations: ['embed'] };

function refusalCode(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    assert.ok(isModelCallNotCovered(err), `not a gate refusal: ${String(err)}`);
    return (err as { code?: string; name: string }).code ?? (err as Error).name;
  }
}

afterEach(() => resetModelGatewayForTests());

describe('model gateway — execution contexts', () => {
  it('observe: a call outside any context is admitted and its call site recorded once per site', async () => {
    setModelGatewayMode('observe');
    for (let i = 0; i < 2; i += 1) admitModelCall('embed');
    const recorded = [...uncoveredModelCalls()];
    assert.equal(recorded.length, 1);
    assert.match(recorded[0]![0], /^embed /);
    assert.equal(recorded[0]![1], 2);
  });

  it('enforce: a call outside any context is refused, inside one it is admitted', async () => {
    setModelGatewayMode('enforce');
    assert.equal(refusalCode(() => admitModelCall('complete')), 'no_context');
    await runInExecutionContext(turn, async () => {
      admitModelCall('complete');
      admitModelCall('run_loop');
      assert.equal(currentExecutionContext()?.agentSlug, 'mira');
    });
  });

  it('a maintenance run only embeds', async () => {
    setModelGatewayMode('enforce');
    await runInExecutionContext(maintenance, async () => {
      admitModelCall('embed');
      for (const op of ['complete', 'transcribe', 'run_loop'] as const satisfies readonly ModelOperation[]) {
        assert.equal(refusalCode(() => admitModelCall(op)), 'operation_not_allowed');
      }
    });
  });

  it('a nested context cannot widen what the outer one allows', async () => {
    await runInExecutionContext(maintenance, () =>
      runInExecutionContext(turn, async () => {
        assert.equal(refusalCode(() => admitModelCall('complete')), 'operation_not_allowed');
      }),
    );
  });

  it('refuses past the deadline and after a cancel', async () => {
    await runInExecutionContext({ ...turn, deadlineAt: Date.now() - 1 }, async () => {
      assert.equal(refusalCode(() => admitModelCall()), 'deadline');
    });
    const cancel = new AbortController();
    await runInExecutionContext({ kind: 'operator_job', ownerId: 'job-1', signal: cancel.signal }, async () => {
      admitModelCall();
      cancel.abort();
      assert.equal(refusalCode(() => admitModelCall()), 'cancelled');
    });
  });

  it('an instance kill switch halts every call, an agent switch that agent only', async () => {
    setModelCallHalts({ instance: 'incident' });
    await runInExecutionContext(turn, async () => {
      assert.equal(refusalCode(() => admitModelCall()), 'kill_switch');
    });
    assert.equal(refusalCode(() => admitModelCall()), 'kill_switch');
    setModelCallHalts({ agents: new Map([['mira', 'runaway']]) });
    await runInExecutionContext(turn, async () => {
      assert.equal(refusalCode(() => admitModelCall()), 'kill_switch');
    });
    await runInExecutionContext({ kind: 'agent_turn', ownerId: 'ben', agentSlug: 'ben' }, async () => {
      admitModelCall();
    });
  });

  it('the ambient agent turn counts as a context; an explicit one wins', async () => {
    setModelGatewayMode('enforce');
    setAmbientExecutionContext(() => turn);
    admitModelCall();
    assert.equal(currentExecutionContext()?.kind, 'agent_turn');
    await runInExecutionContext({ kind: 'execution_scope', ownerId: 'scope-1', agentSlug: 'mira' }, async () => {
      assert.equal(currentExecutionContext()?.kind, 'execution_scope');
    });
  });

  it('a stream keeps its context across every advance', async () => {
    setModelGatewayMode('enforce');
    async function* inner(): AsyncGenerator<string> {
      admitModelCall();
      yield 'a';
      await new Promise((r) => setImmediate(r));
      admitModelCall();
      yield String(currentExecutionContext()?.ownerId);
    }
    const out: string[] = [];
    for await (const v of runGeneratorInExecutionContext(turn, () => inner())) out.push(v);
    assert.deepEqual(out, ['a', 'mira']);
  });

  it('limits still count across nested contexts (#2090)', async () => {
    const result = await meterModelCalls(
      async (probe) => {
        await runInExecutionContext(turn, async () => {
          admitModelCall();
          assert.equal(refusalCode(() => admitModelCall()), 'ModelCallNotCoveredError');
        });
        return probe();
      },
      { limit: 1, context: { kind: 'execution_scope', ownerId: 's', agentSlug: 'mira' } },
    );
    assert.equal(result.modelCalls, 1);
    assert.equal(result.refused, 1);
  });
});

describe('model gateway — embedding and transcription services', () => {
  it('the registry hands out a gated embedding client that keeps its metadata', async () => {
    setModelGatewayMode('enforce');
    const registry = new ServiceRegistry();
    let calls = 0;
    registry.provide('embeddingClient', {
      modelId: 'test:embed',
      dimensions: 3,
      embed: async () => {
        calls += 1;
        return [1, 2, 3];
      },
    });
    const client = registry.get<{ modelId: string; dimensions: number; embed(t: string): Promise<number[]> }>(
      'embeddingClient',
    )!;
    assert.equal(client.modelId, 'test:embed');
    assert.equal(client.dimensions, 3);
    await assert.rejects(client.embed('x'), (err: unknown) => isModelCallNotCovered(err));
    assert.equal(calls, 0);
    await runInExecutionContext(maintenance, async () => {
      assert.deepEqual(await client.embed('x'), [1, 2, 3]);
    });
    assert.equal(calls, 1);
  });

  it('transcription passes the gate as `transcribe`: refused in a maintenance run', async () => {
    const service = gateModelService('transcription', {
      providerId: 'test',
      transcribeFile: async () => ({ text: 'hi' }),
      transcribeStream: async function* () {
        yield { kind: 'partial', itemId: '1', text: 'h' };
      },
    });
    await runInExecutionContext(maintenance, async () => {
      await assert.rejects(service.transcribeFile(), (err: unknown) => isModelCallNotCovered(err));
      assert.throws(() => service.transcribeStream(), (err: unknown) => isModelCallNotCovered(err));
    });
    await runInExecutionContext({ kind: 'inbound_processing', ownerId: 'mira', agentSlug: 'mira' }, async () => {
      assert.deepEqual(await service.transcribeFile(), { text: 'hi' });
    });
  });

  it('wraps once: a replace that decorates the gated service is not gated twice', async () => {
    const registry = new ServiceRegistry();
    registry.provide('embeddingClient', { embed: async () => [0] });
    const gated = registry.get<{ embed(t: string): Promise<number[]> }>('embeddingClient')!;
    assert.equal(gateModelService('embeddingClient', gated), gated);
  });

  it('leaves every other service as it is', () => {
    const impl = { embed: async () => [0] };
    assert.equal(gateModelService('knowledgeGraph', impl), impl);
  });
});
