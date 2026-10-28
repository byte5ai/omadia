/**
 * Issue #1453 — the agent runtime's half of the connection probe.
 *
 * `index.ts` resolves the operator's verify request against BOTH runtimes
 * (`toolPluginRuntime.verifyConnectionNow(id) ?? dynamicAgentRuntime
 * .verifyConnectionNow(id)`), so an uploaded agent package that exports
 * `verifyConnection` has to answer here too.
 *
 * SCOPE, deliberately stated: this seeds `active` and exercises the real
 * `verifyConnectionNow` / `whenConnectionProbesSettled` bodies on the real
 * class. It does NOT drive `activate()` — that needs an orchestrator, a
 * toolkit and an LLM, and what binds the probe during activation is
 * `PluginProbeTracker.bind`, which has its own tests
 * (`pluginProbeTracker.test.ts`). TypeScript's `private` is compile-time only,
 * so the methods under test run unmodified — the same seam
 * `toolPluginRuntimeRouteDisposal.test.ts` uses.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginActionStatus } from '@omadia/plugin-api';

import {
  PluginProbeTracker,
  type BoundProbe,
  type ConnectionProbeStatusSink,
} from '../src/plugins/connectionProbe.js';
import {
  DynamicAgentRuntime,
  type DynamicAgentRuntimeDeps,
} from '../src/plugins/dynamicAgentRuntime.js';

const AGENT_ID = '@test/uploaded-agent';

interface Seeded {
  readonly runtime: DynamicAgentRuntime;
  readonly reports: PluginActionStatus[];
  readonly calls: number[];
  drop(): void;
}

/** Build a runtime whose `active` map holds one agent with a bound probe, as
 *  `activate()` would have left it. */
function seedActiveWithProbe(verdict: {
  readonly status: 'connected' | 'rejected' | 'inconclusive';
  readonly cause?: 'http_401';
  readonly delayMs?: number;
}): Seeded {
  const reports: PluginActionStatus[] = [];
  const calls: number[] = [];
  const sink: ConnectionProbeStatusSink = {
    report(s) {
      reports.push(s);
    },
    clear() {
      /* asserted in pluginConnectionProbe.test.ts */
    },
  };

  const runtime = new DynamicAgentRuntime({
    log: (): void => {},
  } as unknown as DynamicAgentRuntimeDeps);

  const active = (runtime as unknown as { active: Map<string, unknown> }).active;
  // The tracker the runtime itself holds is private; binding through an
  // equivalent one keeps this test to the runtime's own methods.
  const tracker = new PluginProbeTracker({
    isActive: () => active.has(AGENT_ID),
  });
  const probe: BoundProbe | undefined = tracker.bind(
    AGENT_ID,
    {
      verifyConnection: async () => {
        calls.push(1);
        if (verdict.delayMs !== undefined) {
          await new Promise((r) => setTimeout(r, verdict.delayMs));
        }
        return verdict;
      },
    },
    { status: sink },
  );
  assert.ok(probe);

  active.set(AGENT_ID, {
    agentId: AGENT_ID,
    handle: { close: (): Promise<void> => Promise.resolve() },
    probe,
  });

  return {
    runtime,
    reports,
    calls,
    drop: () => {
      active.delete(AGENT_ID);
    },
  };
}

describe('DynamicAgentRuntime — connection probe (#1453)', () => {
  it('re-runs an active agent’s probe and reports the verdict', async () => {
    const s = seedActiveWithProbe({ status: 'rejected', cause: 'http_401' });

    const outcome = await s.runtime.verifyConnectionNow(AGENT_ID);

    assert.equal(outcome?.status, 'rejected');
    assert.equal(outcome?.cause, 'http_401');
    assert.equal(s.calls.length, 1);
    assert.equal(s.reports[0]?.state, 'error');
  });

  it('answers undefined for an agent it is not running', async () => {
    const s = seedActiveWithProbe({ status: 'connected' });

    assert.equal(await s.runtime.verifyConnectionNow('@test/elsewhere'), undefined);
    assert.equal(s.calls.length, 0, 'nothing is probed for an unknown agent');

    s.drop();
    assert.equal(await s.runtime.verifyConnectionNow(AGENT_ID), undefined);
  });

  it('settles its in-flight probes', async () => {
    const s = seedActiveWithProbe({ status: 'connected', delayMs: 20 });

    // Started through the runtime's own tracker-less path: awaiting the
    // settle helper must not hang when nothing is in flight either.
    await s.runtime.whenConnectionProbesSettled();

    const outcome = await s.runtime.verifyConnectionNow(AGENT_ID);
    assert.equal(outcome?.status, 'connected');
    await s.runtime.whenConnectionProbesSettled();
    assert.equal(s.calls.length, 1);
  });
});
