import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { TemplateManifest } from '@omadia/conductor-core';

import {
  ConductorEphemeralRunService,
  EPHEMERAL_SLUG_PREFIX,
  EphemeralInvalidInputError,
  EphemeralQuotaExceededError,
  EphemeralSlotsMissingError,
  PatternNotFoundError,
} from '../src/conductor/ephemeralRunService.js';
import type { ConductorEphemeralStore } from '../src/conductor/ephemeralStore.js';
import type { PatternCatalog } from '../src/conductor/patternCatalog.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';

// #330 — the create+start seam behind `conductorEphemeralRuns`. All fakes, no DB:
// the service's contract is guardrails + provenance + one-call create/start, and
// that is fully observable through what it hands the store/executor.

const PATTERN: TemplateManifest = {
  id: 'demo',
  name: { en: 'Demo pattern' },
  description: { en: 'A demo' },
  useCase: { en: 'demo' },
  defaultSlug: 'demo',
  graph: {
    entryStepId: 's1',
    steps: [{ id: 's1', kind: 'agent', agentId: 'slot:agent:worker', prompt: 'Do {{ctx.goal}}' }],
    transitions: [],
  },
  slots: { agents: [{ key: 'worker', label: { en: 'Worker' } }] },
};

const NOW = new Date('2026-08-21T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const LIMITS = { defaultTtlMs: 24 * HOUR_MS, maxTtlMs: 7 * 24 * HOUR_MS, maxActivePerAgent: 3, maxCreatesPerHour: 10 };

interface Harness {
  service: ConductorEphemeralRunService;
  published: Array<Record<string, unknown>>;
  started: Array<Record<string, unknown>>;
  reaped: string[];
  hardDeleted: string[];
  cancelRequests: Array<{ id: string; by: string }>;
  expired: string[];
}

function harness(opts?: {
  activeRuns?: number;
  recentCreates?: number;
  startRunError?: Error;
  limits?: Partial<typeof LIMITS>;
  openTimerAwait?: boolean;
}): Harness {
  const published: Array<Record<string, unknown>> = [];
  const started: Array<Record<string, unknown>> = [];
  const reaped: string[] = [];
  const hardDeleted: string[] = [];
  const cancelRequests: Array<{ id: string; by: string }> = [];

  const patterns: PatternCatalog = { list: () => [PATTERN], get: (id) => (id === 'demo' ? PATTERN : undefined) };
  const workflowStore = {
    createOrPublish: async (input: Record<string, unknown>) => {
      published.push(input);
      return { workflow: { id: 'wf-1', slug: input.slug }, version: { id: 'ver-1', workflowId: 'wf-1', version: 1 } };
    },
  } as unknown as ConductorWorkflowStore;
  const ephemeralStore = {
    countActiveRunsByAgent: async () => opts?.activeRuns ?? 0,
    countRecentCreatesByAgent: async () => opts?.recentCreates ?? 0,
    markReaped: async (id: string) => {
      reaped.push(id);
    },
    hardDeleteUnreferenced: async (id: string) => {
      hardDeleted.push(id);
      return true;
    },
    requestCancelActiveRuns: async (id: string, by: string) => {
      cancelRequests.push({ id, by });
      return 0;
    },
  } as unknown as ConductorEphemeralStore;
  const expired: string[] = [];
  const executor = {
    startRun: async (input: Record<string, unknown>) => {
      if (opts?.startRunError) throw opts.startRunError;
      started.push(input);
      return { id: 'run-1', status: 'running' };
    },
    expireAwait: async (awaitId: string) => {
      expired.push(awaitId);
    },
  } as unknown as ConductorRunExecutor;

  const service = new ConductorEphemeralRunService({
    patterns,
    workflowStore,
    ephemeralStore,
    executor,
    awaitStore: {
      openTimerAwaitForRun: async (runId: string) =>
        opts?.openTimerAwait && runId === 'run-1' ? { id: 'aw-timer-1', stepId: 'wait' } : null,
    } as never,
    limits: { ...LIMITS, ...opts?.limits },
    now: () => NOW,
  });
  return { service, published, started, reaped, hardDeleted, cancelRequests, expired };
}

const VALID_INPUT = { agentId: 'facilitator-1', patternId: 'demo', slots: { agents: { worker: 'real-agent' } } };

describe('ConductorEphemeralRunService.createEphemeralRun', () => {
  it('rejects invalid boundary input with typed errors', async () => {
    const { service } = harness();
    await assert.rejects(service.createEphemeralRun({ ...VALID_INPUT, agentId: '  ' }), EphemeralInvalidInputError);
    await assert.rejects(service.createEphemeralRun({ ...VALID_INPUT, patternId: '' }), EphemeralInvalidInputError);
    await assert.rejects(
      service.createEphemeralRun({ ...VALID_INPUT, slots: [] as unknown as typeof VALID_INPUT.slots }),
      EphemeralInvalidInputError,
    );
    await assert.rejects(service.createEphemeralRun({ ...VALID_INPUT, ttlMs: -5 }), EphemeralInvalidInputError);
  });

  it('throws PatternNotFoundError for an unknown pattern id', async () => {
    const { service, published } = harness();
    await assert.rejects(service.createEphemeralRun({ ...VALID_INPUT, patternId: 'nope' }), PatternNotFoundError);
    assert.equal(published.length, 0);
  });

  it('throws EphemeralSlotsMissingError when a declared slot is unmapped', async () => {
    const { service, published } = harness();
    await assert.rejects(
      service.createEphemeralRun({ ...VALID_INPUT, slots: {} }),
      (err: unknown) => err instanceof EphemeralSlotsMissingError && err.missing[0]?.key === 'worker',
    );
    assert.equal(published.length, 0);
  });

  it('denies at the concurrent-runs quota before touching the store', async () => {
    const { service, published } = harness({ activeRuns: 3 });
    await assert.rejects(
      service.createEphemeralRun(VALID_INPUT),
      (err: unknown) => err instanceof EphemeralQuotaExceededError && err.kind === 'concurrent',
    );
    assert.equal(published.length, 0);
  });

  it('denies at the hourly create rate limit', async () => {
    const { service, published } = harness({ recentCreates: 10 });
    await assert.rejects(
      service.createEphemeralRun(VALID_INPUT),
      (err: unknown) => err instanceof EphemeralQuotaExceededError && err.kind === 'rate',
    );
    assert.equal(published.length, 0);
  });

  it('clamps a requested TTL to the configured maximum', async () => {
    const { service, published } = harness();
    const out = await service.createEphemeralRun({ ...VALID_INPUT, ttlMs: 30 * 24 * HOUR_MS });
    assert.equal(out.expiresAt, new Date(NOW.getTime() + LIMITS.maxTtlMs).toISOString());
    assert.deepEqual(published[0]!.expiresAt, new Date(NOW.getTime() + LIMITS.maxTtlMs));
  });

  it('defaults the TTL when none is requested', async () => {
    const { service } = harness();
    const out = await service.createEphemeralRun(VALID_INPUT);
    assert.equal(out.expiresAt, new Date(NOW.getTime() + LIMITS.defaultTtlMs).toISOString());
  });

  it('creates + starts in one call: ephemeral origin, eph- slug, expectNew, agent trigger', async () => {
    const { service, published, started } = harness();
    const out = await service.createEphemeralRun({ ...VALID_INPUT, payload: { goal: 'sort roles' } });

    assert.equal(published.length, 1);
    const pub = published[0]!;
    assert.equal(pub.origin, 'ephemeral');
    assert.equal(pub.expectNew, true);
    assert.equal(pub.enable, true);
    assert.equal(pub.createdByAgent, 'facilitator-1');
    assert.ok((pub.slug as string).startsWith(`${EPHEMERAL_SLUG_PREFIX}demo-`));
    // The slot was substituted — the published graph carries the concrete ref.
    const graph = pub.graph as { steps: Array<{ agentId?: string }> };
    assert.equal(graph.steps[0]!.agentId, 'real-agent');

    assert.equal(started.length, 1);
    const start = started[0]!;
    assert.equal(start.slug, pub.slug);
    assert.equal(start.triggerKind, 'agent');
    assert.deepEqual(start.triggerSource, { agentId: 'facilitator-1', patternId: 'demo' });
    assert.deepEqual(start.payload, { goal: 'sort roles' });

    assert.equal(out.runId, 'run-1');
    assert.equal(out.workflowId, 'wf-1');
    assert.equal(out.workflowSlug, pub.slug);
  });

  it('poke() early-fires an open timer await and no-ops without one (#330 C3)', async () => {
    const withTimer = harness({ openTimerAwait: true });
    assert.deepEqual(await withTimer.service.poke('run-1'), { poked: true });
    assert.deepEqual(withTimer.expired, ['aw-timer-1']);

    const without = harness();
    assert.deepEqual(await without.service.poke('run-1'), { poked: false });
    await assert.rejects(without.service.poke('  '), EphemeralInvalidInputError);
  });

  it('best-effort cancels + reaps the scaffold and rethrows when startRun fails', async () => {
    const boom = new Error('start failed');
    const { service, reaped, hardDeleted, cancelRequests } = harness({ startRunError: boom });
    await assert.rejects(service.createEphemeralRun(VALID_INPUT), boom);
    // startRun can throw AFTER the durable run row exists — the cancel request
    // covers that orphan before the definition leaves listReapable via the reap.
    assert.deepEqual(cancelRequests, [{ id: 'wf-1', by: 'agent:facilitator-1' }]);
    assert.deepEqual(reaped, ['wf-1']);
    assert.deepEqual(hardDeleted, ['wf-1']);
  });
});
