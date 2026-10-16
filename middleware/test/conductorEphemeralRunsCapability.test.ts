import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { perCallerService } from '@omadia/plugin-api';
import type { ServiceCaller } from '@omadia/plugin-api';

import type { ConductorEphemeralRunService } from '../src/conductor/ephemeralRunService.js';
import { bindEphemeralRunsToCaller } from '../src/conductor/ephemeralRunsCapability.js';
import type { EphemeralRunsCapability } from '../src/conductor/ephemeralRunsCapability.js';
import { KERNEL_SERVICE_CALLER, ServiceRegistry } from '../src/platform/serviceRegistry.js';

// `conductorEphemeralRuns` is per-caller since 0012: the owner-scoped methods
// trust the kernel-known plugin id, not the agentId the plugin passes. A
// mismatch gets the same answer an unknown run gets, and is logged.

const RUN_ID = '0b9f6c1e-3d2a-4c5b-8e7f-1a2b3c4d5e6f';
const FACILITATOR: ServiceCaller = { agentId: '@omadia/agent-facilitator', pluginId: '@omadia/agent-facilitator' };

function fakeService(): { service: ConductorEphemeralRunService; calls: Array<{ method: string; input: unknown }> } {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record = <T>(method: string, result: T) => async (input: unknown): Promise<T> => {
    calls.push({ method, input });
    return result;
  };
  const service = {
    createEphemeralRun: record('createEphemeralRun', { runId: RUN_ID, workflowId: 'wf', workflowSlug: 'eph-x', expiresAt: 'x' }),
    poke: record('poke', { poked: true }),
    listOwnRuns: record('listOwnRuns', [{ runId: RUN_ID }]),
    saveRunState: record('saveRunState', { saved: true }),
    cancelOwnRun: record('cancelOwnRun', { cancelled: true }),
  } as unknown as ConductorEphemeralRunService;
  return { service, calls };
}

function bound(): { cap: EphemeralRunsCapability; calls: Array<{ method: string; input: unknown }>; logs: string[] } {
  const { service, calls } = fakeService();
  const logs: string[] = [];
  return { cap: bindEphemeralRunsToCaller(service, FACILITATOR, (m) => logs.push(m)), calls, logs };
}

describe('bindEphemeralRunsToCaller', () => {
  it('forwards owner-scoped calls when the claimed agentId is the kernel-known caller', async () => {
    const { cap, calls } = bound();
    assert.deepEqual(await cap.listOwnRuns({ agentId: ' @omadia/agent-facilitator ' }), [{ runId: RUN_ID }]);
    assert.deepEqual(await cap.saveRunState({ agentId: '@omadia/agent-facilitator', runId: RUN_ID, state: { v: 1 } }), {
      saved: true,
    });
    assert.deepEqual(
      await cap.cancelOwnRun({ agentId: '@omadia/agent-facilitator', runId: RUN_ID, reason: 'done' }),
      { cancelled: true },
    );
    // The forwarded agentId is the caller's, never the (trimmed) claim.
    assert.deepEqual(calls.map((c) => (c.input as { agentId: string }).agentId), [
      '@omadia/agent-facilitator',
      '@omadia/agent-facilitator',
      '@omadia/agent-facilitator',
    ]);
    assert.equal((calls[2]!.input as { reason?: string }).reason, 'done');
  });

  it('refuses a foreign agentId with the unknown-run answer and logs it', async () => {
    const { cap, calls, logs } = bound();
    assert.deepEqual(await cap.listOwnRuns({ agentId: '@other/agent' }), []);
    assert.deepEqual(await cap.saveRunState({ agentId: '@other/agent', runId: RUN_ID, state: {} }), { saved: false });
    assert.deepEqual(await cap.cancelOwnRun({ agentId: '@other/agent', runId: RUN_ID }), {
      cancelled: false,
      reason: 'not_found',
    });
    assert.equal(calls.length, 0, 'nothing reaches the service');
    assert.equal(logs.filter((l) => l.includes("claimed agentId '@other/agent' — refused")).length, 3);
  });

  it('treats a missing/blank agentId as a mismatch and sanitizes the log line', async () => {
    const { cap, calls, logs } = bound();
    assert.deepEqual(await cap.listOwnRuns({} as { agentId: string }), []);
    assert.deepEqual(await cap.listOwnRuns({ agentId: 'x\n[forged]' }), []);
    assert.equal(calls.length, 0);
    assert.ok(logs.every((l) => !l.includes('\n')));
  });

  it('keeps createEphemeralRun and poke pass-through, logging a create under a foreign id', async () => {
    const { cap, calls, logs } = bound();
    const input = { agentId: '@omadia/agent-facilitator', patternId: 'facilitation', slots: {} };
    await cap.createEphemeralRun(input);
    await cap.createEphemeralRun({ ...input, agentId: '@other/agent' });
    await cap.poke(RUN_ID);
    assert.deepEqual(calls.map((c) => c.method), ['createEphemeralRun', 'createEphemeralRun', 'poke']);
    assert.equal(logs.length, 1);
    assert.ok(logs[0]!.includes("creates as '@other/agent'"));
  });
});

describe('conductorEphemeralRuns registration (perCallerService)', () => {
  it('hands plugins a bound capability and the kernel the unscoped service', async () => {
    const { service, calls } = fakeService();
    const registry = new ServiceRegistry();
    registry.provide(
      'conductorEphemeralRuns',
      perCallerService((caller) =>
        caller.pluginId === KERNEL_SERVICE_CALLER.pluginId
          ? service
          : bindEphemeralRunsToCaller(service, caller, () => undefined),
      ),
    );

    assert.equal(registry.get('conductorEphemeralRuns'), service, 'kernel resolution is unscoped');

    const evil = registry.get<EphemeralRunsCapability>('conductorEphemeralRuns', {
      agentId: '@evil/plugin',
      pluginId: '@evil/plugin',
    });
    assert.ok(evil);
    assert.deepEqual(await evil.listOwnRuns({ agentId: '@omadia/agent-facilitator' }), []);
    assert.equal(calls.length, 0);

    const facilitator = registry.get<EphemeralRunsCapability>('conductorEphemeralRuns', FACILITATOR);
    assert.deepEqual(await facilitator!.listOwnRuns({ agentId: '@omadia/agent-facilitator' }), [{ runId: RUN_ID }]);
  });
});
