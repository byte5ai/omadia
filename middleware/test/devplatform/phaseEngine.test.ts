import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PhaseEngine,
  StalePhaseError,
  type PhaseEngineDeps,
  type PhaseEngineStore,
  type PhaseResultInput,
} from '../../src/devplatform/pipeline/phaseEngine.js';
import type { DevJob, DevJobPhase } from '../../src/devplatform/types.js';
import type { DevJobGate, OpenGateInput } from '../../src/devplatform/pipeline/gateStore.js';

function job(over: Partial<DevJob> = {}): DevJob {
  return {
    id: 'job-1',
    repoId: 'repo-1',
    kind: 'fix_issue',
    brief: 'do it',
    source: 'admin',
    sourceRef: 'gh-issue:1',
    baseSha: 'deadbeef',
    backend: 'docker',
    agentKind: 'claude-cli',
    authMode: 'api_key',
    provision: 1,
    phase: 'analyze',
    pipelineMode: 'gated',
    reviewAttempt: 0,
    reviewFingerprint: null,
    retryOf: null,
    status: 'running',
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    runnerHandle: null,
    runnerTokenHash: null,
    branch: null,
    prUrl: null,
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    createdBy: 'user-1',
    createdAt: '2026-07-10T00:00:00Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-07-10T00:00:00Z',
    ...over,
  };
}

interface Harness {
  engine: PhaseEngine;
  phase: { value: DevJobPhase };
  artifacts: Array<{ kind: string; content: string; meta: Record<string, unknown>; id: string }>;
  readonly reviewState: { attempt: number; fingerprint: string | null };
  gatesOpened: OpenGateInput[];
  finalized: Array<{ status: string; reason?: string }>;
  /** Live views into the mutated state — NOT snapshots (primitives spread-copy). */
  readonly parkRevoked: number;
  readonly parked: boolean;
}

function harness(j: DevJob): Harness {
  const state = {
    phase: { value: j.phase },
    artifacts: [] as Array<{ kind: string; content: string; meta: Record<string, unknown>; id: string }>,
    reviewState: { attempt: j.reviewAttempt, fingerprint: j.reviewFingerprint },
    gatesOpened: [] as OpenGateInput[],
    finalized: [] as Array<{ status: string; reason?: string }>,
    parkRevoked: 0,
    parked: false,
  };
  const store: PhaseEngineStore = {
    async addArtifact(_jobId, kind, content, meta) {
      state.artifacts.push({ kind, content, meta: meta ?? {}, id: `art-${state.artifacts.length + 1}` });
      return `art-${state.artifacts.length}`;
    },
    async getLatestArtifact(_jobId, kind) {
      const matches = state.artifacts.filter((a) => a.kind === kind);
      const last = matches[matches.length - 1];
      return last ? { id: last.id, meta: last.meta } : null;
    },
    async advancePhase(_jobId, from, to) {
      if (state.phase.value !== from) return false;
      state.phase.value = to;
      return true;
    },
    async parkForGate() {
      state.parked = true;
      return true;
    },
    async setReviewState(_jobId, attempt, fingerprint) {
      state.reviewState = { attempt, fingerprint };
    },
  };
  const gates = {
    async open(input: OpenGateInput): Promise<DevJobGate> {
      state.gatesOpened.push(input);
      return { id: 'gate-1', jobId: input.jobId, status: 'waiting' } as DevJobGate;
    },
  };
  const deps: PhaseEngineDeps = {
    store,
    gates: gates as unknown as PhaseEngineDeps['gates'],
    finalize: async (_jobId, status, reason) => void state.finalized.push({ status, reason }),
    revokeTokensForPark: async () => void (state.parkRevoked += 1),
    gatePrincipal: () => ({ kind: 'user', ref: 'user-1' }),
  };
  return {
    engine: new PhaseEngine(deps),
    phase: state.phase,
    artifacts: state.artifacts,
    get reviewState() {
      return state.reviewState;
    },
    gatesOpened: state.gatesOpened,
    finalized: state.finalized,
    get parkRevoked() {
      return state.parkRevoked;
    },
    get parked() {
      return state.parked;
    },
  };
}

/** Drive a result; the harness keeps job.phase in sync with the store. */
async function step(h: Harness, j: DevJob, input: PhaseResultInput) {
  const current = job({ ...j, phase: h.phase.value, reviewAttempt: h.reviewState.attempt, reviewFingerprint: h.reviewState.fingerprint });
  return h.engine.handlePhaseResult(current, input);
}

describe('devplatform/phaseEngine — a full gated job, phase by phase', () => {
  it('runs analyze→bootstrap→plan→clarify→PARK, then implement→review→pr→done', async () => {
    const j = job();
    const h = harness(j);

    assert.deepEqual(await step(h, j, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: '{}' } }), {
      directive: 'next',
      phase: 'bootstrap',
    });
    assert.deepEqual(await step(h, j, { phase: 'bootstrap', ok: true, artifact: { kind: 'bootstrap_report', content: '{}' } }), {
      directive: 'next',
      phase: 'plan',
    });
    assert.deepEqual(
      await step(h, j, {
        phase: 'plan',
        ok: true,
        artifact: { kind: 'plan', content: 'the plan', meta: { planSha256: 'plan-hash-abc' } },
      }),
      { directive: 'next', phase: 'clarify' },
    );
    // clarify → park: gate opens, token revoked, runner told to exit.
    assert.deepEqual(await step(h, j, { phase: 'clarify', ok: true, questions: [{ id: 'q1', text: 'which?' }] }), {
      directive: 'park',
    });
    assert.equal(h.phase.value, 'await_human');
    assert.equal(h.parked, true);
    assert.equal(h.parkRevoked, 1, 'the parked runner’s token is revoked');
    assert.equal(h.gatesOpened.length, 1);
    assert.deepEqual(h.gatesOpened[0]!.questions, [{ id: 'q1', text: 'which?' }]);
    assert.equal(h.gatesOpened[0]!.baseSha, 'deadbeef', 'the gate pins the base tree');
    // Forge #1: the gate must pin the PERSISTED plan (delivered in the plan phase,
    // not the clarify result) — otherwise a resume implements against an
    // unapproved plan.
    assert.equal(h.gatesOpened[0]!.planSha256, 'plan-hash-abc', 'the gate pins the approved plan hash');
    assert.ok(h.gatesOpened[0]!.planArtifactId, 'the gate references the plan artifact');

    // Provision B (after the gate resolves and the job re-queues at implement).
    h.phase.value = 'implement';
    assert.deepEqual(await step(h, j, { phase: 'implement', ok: true, artifact: { kind: 'diff', content: 'a diff' } }), {
      directive: 'next',
      phase: 'review',
    });
    assert.deepEqual(
      await step(h, j, {
        phase: 'review',
        ok: true,
        artifact: { kind: 'review_verdict', content: '{}' },
        verdict: { verdict: 'approve', summary: 'lgtm', findings: [] },
      }),
      { directive: 'next', phase: 'pr' },
    );
    // pr is host-only; driving it here terminates the job.
    assert.deepEqual(await step(h, j, { phase: 'pr', ok: true }), { directive: 'done' });
    assert.deepEqual(h.finalized, [{ status: 'done', reason: undefined }]);
  });
});

describe('devplatform/phaseEngine — the review loop', () => {
  it('request_changes loops back to implement, keeping the fingerprint', async () => {
    const j = job({ phase: 'review' });
    const h = harness(j);
    const d = await step(h, j, {
      phase: 'review',
      ok: true,
      verdict: {
        verdict: 'request_changes',
        summary: 'no',
        findings: [{ severity: 'blocker', file: 'a.ts', issue: 'boom' }],
      },
    });
    assert.deepEqual(d, { directive: 'next', phase: 'implement' });
    assert.equal(h.reviewState.attempt, 1, 'the attempt counter advanced');
    assert.ok(h.reviewState.fingerprint, 'the fingerprint was stored');
  });

  it('an identical fingerprint gives up and proceeds to pr, not another loop', async () => {
    const verdict = {
      verdict: 'request_changes',
      summary: 'no',
      findings: [{ severity: 'blocker', file: 'a.ts', issue: 'boom' }],
    };
    // Precompute the fingerprint by running once against a fresh job.
    const j0 = job({ phase: 'review' });
    const h0 = harness(j0);
    await step(h0, j0, { phase: 'review', ok: true, verdict });
    const fp = h0.reviewState.fingerprint;

    const j = job({ phase: 'review', reviewAttempt: 1, reviewFingerprint: fp });
    const h = harness(j);
    const d = await step(h, j, { phase: 'review', ok: true, verdict });
    assert.deepEqual(d, { directive: 'next', phase: 'pr' }, 'a non-converging loop stops at pr');
  });

  it('a minor-only request_changes is treated as approve → pr', async () => {
    const j = job({ phase: 'review' });
    const h = harness(j);
    const d = await step(h, j, {
      phase: 'review',
      ok: true,
      verdict: { verdict: 'request_changes', summary: 'nits', findings: [{ severity: 'minor', file: 'a', issue: 'nit' }] },
    });
    assert.deepEqual(d, { directive: 'next', phase: 'pr' });
  });

  it('a malformed verdict fails the job', async () => {
    const j = job({ phase: 'review' });
    const h = harness(j);
    const d = await step(h, j, { phase: 'review', ok: true, verdict: { garbage: true } });
    assert.equal(d.directive, 'failed');
    assert.equal(h.finalized[0]?.status, 'failed');
  });
});

describe('devplatform/phaseEngine — collapsed mode + guards', () => {
  it('collapsed skips the gate: analyze → implement', async () => {
    const j = job({ pipelineMode: 'collapsed' });
    const h = harness(j);
    assert.deepEqual(await step(h, j, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: '{}' } }), {
      directive: 'next',
      phase: 'implement',
    });
  });

  it('kind=analyze terminates after analyze', async () => {
    const j = job({ kind: 'analyze' });
    const h = harness(j);
    assert.deepEqual(await step(h, j, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: '{}' } }), {
      directive: 'done',
    });
  });

  it('rejects a stale phase result (409) without mutating state', async () => {
    const j = job({ phase: 'implement' });
    const h = harness(j);
    await assert.rejects(
      // A stale result carrying an artifact must be rejected BEFORE the artifact
      // is persisted — otherwise a late runner litters the job with stale plans.
      () => h.engine.handlePhaseResult(j, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: 'stale' } }),
      (e: unknown) => e instanceof StalePhaseError,
    );
    assert.equal(h.artifacts.length, 0, 'a stale result persists nothing');
  });

  it('any ok:false fails the job with the runner’s error', async () => {
    const j = job({ phase: 'implement' });
    const h = harness(j);
    const d = await step(h, j, { phase: 'implement', ok: false, error: 'agent crashed' });
    assert.deepEqual(d, { directive: 'failed', reason: 'agent crashed' });
    assert.equal(h.finalized[0]?.status, 'failed');
  });
});
