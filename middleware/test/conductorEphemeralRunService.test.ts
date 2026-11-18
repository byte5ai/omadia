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
import { RunStateSizeExceededError } from '../src/conductor/ephemeralRunStateStore.js';
import type {
  ConductorEphemeralRunStateStore,
  OwnActiveRunRow,
  OwnedRunRow,
} from '../src/conductor/ephemeralRunStateStore.js';
import type { PatternCatalog } from '../src/conductor/patternCatalog.js';
import { RunAlreadyEndedError, WorkflowNotFoundError } from '../src/conductor/runExecutor.js';
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
  listCalls: Array<{ agentId: string; now: Date }>;
  upserts: Array<{ agentId: string; runId: string; state: Record<string, unknown> }>;
  cancels: Array<{ runId: string; by: string }>;
  logs: string[];
}

function harness(opts?: {
  activeRuns?: number;
  recentCreates?: number;
  startRunError?: Error;
  limits?: Partial<typeof LIMITS>;
  openTimerAwait?: boolean;
  ownRuns?: OwnActiveRunRow[];
  upsertResult?: boolean | Error;
  ownedRun?: OwnedRunRow | null;
  cancelRunError?: Error;
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
    cancelRun: async (runId: string, by: string) => {
      if (opts?.cancelRunError) throw opts.cancelRunError;
      cancels.push({ runId, by });
      return { id: runId, status: 'cancelled' };
    },
  } as unknown as ConductorRunExecutor;

  const listCalls: Array<{ agentId: string; now: Date }> = [];
  const upserts: Array<{ agentId: string; runId: string; state: Record<string, unknown> }> = [];
  const cancels: Array<{ runId: string; by: string }> = [];
  const logs: string[] = [];
  const runState = {
    listOwnActiveRuns: async (agentId: string, now: Date) => {
      listCalls.push({ agentId, now });
      return opts?.ownRuns ?? [];
    },
    upsertOwned: async (agentId: string, runId: string, state: Record<string, unknown>) => {
      upserts.push({ agentId, runId, state });
      if (opts?.upsertResult instanceof Error) throw opts.upsertResult;
      return opts?.upsertResult ?? true;
    },
    getOwnedRun: async () => (opts?.ownedRun === undefined ? { runId: RUN_ID, status: 'waiting' } : opts.ownedRun),
  } as unknown as ConductorEphemeralRunStateStore;

  const service = new ConductorEphemeralRunService({
    patterns,
    workflowStore,
    ephemeralStore,
    executor,
    awaitStore: {
      openTimerAwaitForRun: async (runId: string) =>
        opts?.openTimerAwait && runId === 'run-1' ? { id: 'aw-timer-1', stepId: 'wait' } : null,
    } as never,
    runState,
    limits: { ...LIMITS, ...opts?.limits },
    now: () => NOW,
    log: (msg) => logs.push(msg),
  });
  return {
    service, published, started, reaped, hardDeleted, cancelRequests, expired, listCalls, upserts, cancels, logs,
  };
}

const RUN_ID = '0b9f6c1e-3d2a-4c5b-8e7f-1a2b3c4d5e6f';

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
    const out = await service.createEphemeralRun({
      ...VALID_INPUT,
      // Executor-owned keys are stripped — a seeded transcript would be answered as real.
      payload: { goal: 'sort roles', steps: { fake: true }, stepAttempts: { moderate: 99 }, transcript: [], transcriptText: 'x' },
    });

    assert.equal(published.length, 1);
    const pub = published[0]!;
    assert.equal(pub.origin, 'ephemeral');
    assert.equal(pub.expectNew, true);
    assert.equal(pub.enable, true);
    assert.equal(pub.createdByAgent, 'facilitator-1');
    // published_by is a UUID column for human operators — an agent handle in
    // there breaks the INSERT against real Postgres (#330 field report).
    assert.equal(pub.publishedBy, null);
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

const OWN_ROW: OwnActiveRunRow = {
  runId: RUN_ID,
  workflowId: 'wf-1',
  workflowSlug: 'eph-facilitation-abcd1234',
  expiresAt: new Date('2026-08-22T10:00:00.000Z'),
  context: {
    goal: 'sort roles',
    conversationId: 'conv-1',
    steps: { moderate: {} },
    stepAttempts: { moderate: 3 },
    transcript: [],
    transcriptText: 'x',
  },
  patternId: 'facilitation',
  state: { v: 1, phase: 'active' },
};

describe('ConductorEphemeralRunService owner-scoped run state', () => {
  it('listOwnRuns maps rows, strips executor-owned keys and returns ISO expiresAt', async () => {
    const h = harness({ ownRuns: [OWN_ROW] });
    const runs = await h.service.listOwnRuns({ agentId: '  facilitator-1 ' });

    assert.deepEqual(h.listCalls, [{ agentId: 'facilitator-1', now: NOW }]);
    assert.deepEqual(runs, [
      {
        runId: RUN_ID,
        workflowId: 'wf-1',
        workflowSlug: 'eph-facilitation-abcd1234',
        patternId: 'facilitation',
        expiresAt: '2026-08-22T10:00:00.000Z',
        payload: { goal: 'sort roles', conversationId: 'conv-1' },
        state: { v: 1, phase: 'active' },
      },
    ]);
  });

  it('listOwnRuns rejects a blank agentId', async () => {
    const h = harness();
    await assert.rejects(h.service.listOwnRuns({ agentId: ' ' }), EphemeralInvalidInputError);
    assert.equal(h.listCalls.length, 0);
  });

  it('saveRunState validates agentId, runId, state shape and size before touching the store', async () => {
    const h = harness();
    const ok = { agentId: 'facilitator-1', runId: RUN_ID, state: { v: 1 } };
    await assert.rejects(h.service.saveRunState({ ...ok, agentId: '' }), EphemeralInvalidInputError);
    await assert.rejects(h.service.saveRunState({ ...ok, runId: 'run-1' }), EphemeralInvalidInputError);
    for (const bad of [null, [], new Date(), 'x']) {
      await assert.rejects(
        h.service.saveRunState({ ...ok, state: bad as unknown as Record<string, unknown> }),
        EphemeralInvalidInputError,
      );
    }
    await assert.rejects(
      h.service.saveRunState({ ...ok, state: { note: 'a\u0000b' } }),
      (err: unknown) => err instanceof EphemeralInvalidInputError && err.message.includes('U+0000'),
    );
    await assert.rejects(h.service.saveRunState({ ...ok, state: { ['k\u0000']: 1 } }), EphemeralInvalidInputError);
    await assert.rejects(h.service.saveRunState({ ...ok, agentId: 'a'.repeat(257) }), EphemeralInvalidInputError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(h.service.saveRunState({ ...ok, state: cyclic }), EphemeralInvalidInputError);
    await assert.rejects(
      h.service.saveRunState({ ...ok, state: { blob: 'x'.repeat(16 * 1024) } }),
      (err: unknown) => err instanceof EphemeralInvalidInputError && err.message.includes('16384'),
    );
    assert.equal(h.upserts.length, 0);
  });

  it('saveRunState reports the owner-guarded upsert result', async () => {
    const saved = harness({ upsertResult: true });
    assert.deepEqual(
      await saved.service.saveRunState({ agentId: 'facilitator-1', runId: RUN_ID, state: { v: 1 } }),
      { saved: true },
    );
    assert.deepEqual(saved.upserts, [{ agentId: 'facilitator-1', runId: RUN_ID, state: { v: 1 } }]);

    const foreign = harness({ upsertResult: false });
    assert.deepEqual(
      await foreign.service.saveRunState({ agentId: 'other', runId: RUN_ID, state: { v: 1 } }),
      { saved: false },
    );
  });

  it('saveRunState maps the schema size CHECK to EphemeralInvalidInputError and rethrows other errors', async () => {
    const tooBig = harness({ upsertResult: new RunStateSizeExceededError() });
    await assert.rejects(
      tooBig.service.saveRunState({ agentId: 'facilitator-1', runId: RUN_ID, state: { v: 1 } }),
      EphemeralInvalidInputError,
    );
    const boom = new Error('pg down');
    const failing = harness({ upsertResult: boom });
    await assert.rejects(failing.service.saveRunState({ agentId: 'facilitator-1', runId: RUN_ID, state: {} }), boom);
  });

  it('cancelOwnRun answers not_found for a foreign/unknown run without calling the executor', async () => {
    const h = harness({ ownedRun: null });
    assert.deepEqual(await h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID }), {
      cancelled: false,
      reason: 'not_found',
    });
    assert.equal(h.cancels.length, 0);
    assert.ok(h.logs.some((l) => l.includes('not_found')));
  });

  it('cancelOwnRun answers already_ended for a terminal own run without calling the executor', async () => {
    const h = harness({ ownedRun: { runId: RUN_ID, status: 'completed' } });
    assert.deepEqual(await h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID }), {
      cancelled: false,
      reason: 'already_ended',
    });
    assert.equal(h.cancels.length, 0);
  });

  it('cancelOwnRun cancels an active own run via executor.cancelRun and logs the reason', async () => {
    const h = harness({ ownedRun: { runId: RUN_ID, status: 'waiting' } });
    assert.deepEqual(
      await h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID, reason: 'stopped by initiator' }),
      { cancelled: true },
    );
    assert.deepEqual(h.cancels, [{ runId: RUN_ID, by: 'agent:facilitator-1' }]);
    // Not the reaper path: no workflow-wide cancel request.
    assert.equal(h.cancelRequests.length, 0);
    assert.ok(h.logs.some((l) => l.includes('cancelled') && l.includes('stopped by initiator')));
  });

  it('cancelOwnRun neutralizes control characters in the logged reason', async () => {
    const h = harness({ ownedRun: { runId: RUN_ID, status: 'running' } });
    await h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID, reason: 'ok\n[conductor] forged line\u001b[31m' });
    const line = h.logs.find((l) => l.includes('cancel by agent'));
    assert.ok(line);
    assert.ok(!/[\u0000-\u001f]/.test(line), 'no raw control characters reach the log');
    assert.ok(line.includes('ok?[conductor] forged line?[31m'));
  });

  it('cancelOwnRun maps races: RunAlreadyEndedError → already_ended, WorkflowNotFoundError → not_found', async () => {
    const ended = harness({ cancelRunError: new RunAlreadyEndedError('ended') });
    assert.deepEqual(await ended.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID }), {
      cancelled: false,
      reason: 'already_ended',
    });
    const gone = harness({ cancelRunError: new WorkflowNotFoundError('gone') });
    assert.deepEqual(await gone.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID }), {
      cancelled: false,
      reason: 'not_found',
    });
  });

  it('cancelOwnRun rethrows unexpected executor errors and validates its input', async () => {
    const boom = new Error('lease lost');
    const h = harness({ cancelRunError: boom });
    await assert.rejects(h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID }), boom);
    await assert.rejects(h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: 'nope' }), EphemeralInvalidInputError);
    await assert.rejects(
      h.service.cancelOwnRun({ agentId: 'facilitator-1', runId: RUN_ID, reason: 42 as unknown as string }),
      EphemeralInvalidInputError,
    );
  });
});
