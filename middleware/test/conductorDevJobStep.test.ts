import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import { subscribeDevJobResolver } from '../src/conductor/devJobStepEffect.js';
import { DevJobOutcomeEmitter } from '../src/devplatform/devJobConductorBridge.js';

// Epic #470 W3 — the dev-job Conductor step effect. All fakes, no worker, no pg.
//
// Graph: a dev-job step `dj1` that branches on the terminal outcome —
//   status == 'done'  → happy transition t_ok    → step `ok`
//   otherwise         → fallback  transition t_denied → step `denied`
// Both `ok` and `denied` are ordinary (no-op) action steps with no outgoing transition, so
// once the run reaches either it executes a stub effect and completes. This proves the
// WORKFLOW — not the effect — decides what happens after the job, from the outcome alone.
const graphBranch = {
  entryStepId: 'dj1',
  steps: [
    { id: 'dj1', kind: 'action', actionId: 'dev.job', fallbackTransitionId: 't_denied' },
    { id: 'ok', kind: 'action', actionId: 'noop' },
    { id: 'denied', kind: 'action', actionId: 'noop' },
  ],
  transitions: [
    { id: 't_ok', source: 'dj1', target: 'ok', guard: { op: 'eq', path: 'stepResult.status', value: 'done' } },
    { id: 't_denied', source: 'dj1', target: 'denied' },
  ],
};

interface RecordedStep {
  stepId: string;
  actor: { kind?: string; jobId?: string; status?: string } | null;
  status: string;
  nextStepId: string | null;
  context: { steps?: Record<string, Record<string, unknown>> };
}

function makeWorld(graph: unknown) {
  const run = {
    id: 'run1', workflowVersionId: 'v1', status: 'running', currentStepId: null as string | null,
    context: {} as Record<string, unknown>, triggerKind: 'manual', triggerSource: null,
    isDryRun: false, startedAt: new Date(0), endedAt: null,
  };
  const steps: RecordedStep[] = [];
  interface AwaitRow {
    id: string; runId: string; stepId: string; status: string;
    principalRef: string; channelType: string; fallbackTransitionId: string | null;
  }
  const awaits = new Map<string, AwaitRow>();
  const byRunStep = new Map<string, string>();
  const devJobLink = new Map<string, string>(); // jobId → awaitId (models dev_jobs.conductor_await_id)
  const terminalJobs = new Map<string, { jobId: string; status: string; prUrl?: string | null; result?: unknown; error?: string | null }>();
  const launchCalls: Array<{ runId: string; stepId: string }> = [];
  const launchByKey = new Map<string, string>(); // (runId,stepId) → jobId (launch idempotency)
  let awaitCounter = 0;
  let jobCounter = 0;

  const workflowStore = {
    async getBySlug(slug: string) { return { id: 'w1', slug, status: 'active', activeVersionId: 'v1' }; },
    async getVersion() { return { id: 'v1', workflowId: 'w1', version: 1, graph }; },
  };
  const runStore = {
    async create(input: { entryStepId: string; context: Record<string, unknown> }) {
      run.status = 'running'; run.currentStepId = input.entryStepId; run.context = input.context; return run;
    },
    async get() { return run; },
    async stepsForRun() { return steps; },
    async acquireLease() {},
    async recordStepAndAdvance(input: RecordedStep) {
      steps.push(input);
      run.currentStepId = input.nextStepId; run.status = input.status; run.context = input.context;
    },
    async park(_runId: string, stepId: string, context: Record<string, unknown>) {
      run.status = 'waiting'; run.currentStepId = stepId; run.context = context;
    },
  };
  const awaitStore = {
    async create(input: {
      runId: string; stepId: string; principalRef: string; channelType: string;
      fallbackTransitionId: string | null;
    }) {
      const key = `${input.runId}:${input.stepId}`;
      const existingId = byRunStep.get(key);
      if (existingId && awaits.get(existingId)!.status === 'waiting') return awaits.get(existingId)!;
      const id = `aw${++awaitCounter}`;
      const row: AwaitRow = {
        id, runId: input.runId, stepId: input.stepId, status: 'waiting',
        principalRef: input.principalRef, channelType: input.channelType,
        fallbackTransitionId: input.fallbackTransitionId,
      };
      awaits.set(id, row); byRunStep.set(key, id); return row;
    },
    async get(id: string) { return awaits.get(id) ?? null; },
    async close(id: string, status: string) {
      const row = awaits.get(id);
      if (row && row.status === 'waiting') { row.status = status; return true; }
      return false;
    },
    async listWaitingDevJobAwaits() {
      return [...awaits.values()].filter((a) => a.status === 'waiting' && a.channelType === 'dev_job');
    },
  };
  const port = {
    async launch(input: { runId: string; stepId: string }) {
      launchCalls.push({ runId: input.runId, stepId: input.stepId });
      const key = `${input.runId}:${input.stepId}`;
      const existing = launchByKey.get(key);
      if (existing) return { jobId: existing }; // idempotent per (runId, stepId)
      const jobId = `job${++jobCounter}`;
      launchByKey.set(key, jobId); return { jobId };
    },
    async bindAwait(jobId: string, awaitId: string) { devJobLink.set(jobId, awaitId); },
    async awaitIdForJob(jobId: string) { return devJobLink.get(jobId) ?? null; },
    async terminalOutcomeForJob(jobId: string) { return terminalJobs.get(jobId) ?? null; },
  };
  const effects = {
    async runAgentStep(): Promise<never> { throw new Error('unused'); },
    async runActionStep(step: { id: string; actionId?: string }) {
      return { result: { executed: step.id }, actor: { kind: 'action', actionId: step.actionId ?? null } };
    },
  };

  const executor = new ConductorRunExecutor({
    workflowStore: workflowStore as never,
    runStore: runStore as never,
    awaitStore: awaitStore as never,
    effects: effects as never,
    resolveRoleHolders: async () => [],
    devJob: port as never,
  });

  const setJobTerminal = (
    jobId: string,
    o: { status: string; prUrl?: string | null; result?: unknown; error?: string | null },
  ) => { terminalJobs.set(jobId, { jobId, ...o }); };

  return { executor, run, steps, awaits, awaitStore, port, launchCalls, setJobTerminal };
}

describe('dev-job step — launch + park (guarantee a, d)', () => {
  it('reaching the step launches exactly one job and parks the run waiting with an await bound to the jobId', async () => {
    const w = makeWorld(graphBranch);
    const result = await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    // Exactly one job launched. FAIL-IF-REVERTED: a re-drive that double-launched, or a launch
    // per tick, would push launchCalls past 1.
    assert.equal(w.launchCalls.length, 1);
    // The run is parked, not advanced. FAIL-IF-REVERTED: if openDevJobAwait skipped `park`, the
    // run would still be 'running' (or would have executed the action effect and completed).
    assert.equal(result.status, 'waiting');
    assert.equal(w.run.status, 'waiting');
    assert.equal(w.run.currentStepId, 'dj1');
    // No premature advance: nextStep never ran, so no step was recorded (guarantee d).
    // FAIL-IF-REVERTED: resuming the run before the job finished would record dj1 here.
    assert.equal(w.steps.length, 0);
    // The await is durably bound to the launched job (dev_jobs.conductor_await_id link).
    const awaitId = await w.port.awaitIdForJob('job1');
    assert.ok(awaitId, 'the launched job must be bound to an await');
    const aw = await w.awaitStore.get(awaitId!);
    assert.equal(aw!.status, 'waiting');
    assert.equal(aw!.stepId, 'dj1');
    assert.equal(aw!.channelType, 'dev_job');
    // Footgun fix (Option B): the dev-job await carries NO fallbackTransitionId even though the
    // STEP declares one (`t_denied`). Dev-job failure branching is graph-level (honoured by
    // nextStep in resolveDevJobAwait), not an await-level field that would be dead data.
    // FAIL-IF-REVERTED: copying step.fallbackTransitionId onto the await would make this 't_denied'.
    assert.equal(aw!.fallbackTransitionId, null);
  });
});

describe('dev-job step — terminal-before-bind reconciliation (guarantee HIGH)', () => {
  it('reconcileTerminalDevJobAwaits resolves an already-terminal job whose emit was lost, so the run advances (not hung)', async () => {
    const w = makeWorld(graphBranch);
    // Park normally: await is created + bound, run waiting. This is also the post-re-drive state of
    // the terminal-before-bind race — the second openDevJobAwait binds the await, but the job is
    // already terminal so the edge-triggered emitter will never fire again.
    await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    assert.equal(w.run.status, 'waiting');
    assert.equal(w.steps.length, 0);

    // The job finished (done) but no emit reached resolveDevJobAwait — the lost wakeup.
    w.setJobTerminal('job1', { status: 'done', prUrl: 'https://pr/7' });

    const n = await w.executor.reconcileTerminalDevJobAwaits();

    // The sweep recovered the parked run: it advanced down the happy path and completed.
    // FAIL-IF-REVERTED: without the sweep the run stays 'waiting' forever (steps stays empty).
    assert.equal(n, 1);
    assert.equal(w.run.status, 'completed');
    assert.deepEqual(w.steps.map((s) => s.stepId), ['dj1', 'ok']);
    assert.equal(w.steps.find((s) => s.stepId === 'dj1')!.context.steps!.dj1!.prUrl, 'https://pr/7');

    // Idempotent: a second sweep finds no waiting dev-job await and does nothing.
    const again = await w.executor.reconcileTerminalDevJobAwaits();
    assert.equal(again, 0);
  });

  it('reconcile leaves a still-running job parked (no premature resume)', async () => {
    const w = makeWorld(graphBranch);
    await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    // job1 is NOT terminal → terminalOutcomeForJob returns null.
    const n = await w.executor.reconcileTerminalDevJobAwaits();
    // FAIL-IF-REVERTED: resuming a non-terminal job here would advance the run mid-job.
    assert.equal(n, 0);
    assert.equal(w.run.status, 'waiting');
    assert.equal(w.steps.length, 0);
  });
});

describe('dev-job step — terminal resume (guarantee b, c)', () => {
  it('resolving with a terminal `done` outcome resumes the run and the step result carries pr_url', async () => {
    const w = makeWorld(graphBranch);
    await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    await w.executor.resolveDevJobAwait({
      jobId: 'job1', status: 'done', prUrl: 'https://pr/1', result: { outcome: 'diff_ready' },
    });

    // The run resumed and branched down the happy path (guard `status == 'done'`).
    // FAIL-IF-REVERTED: if the outcome were not fed as the step result, the guard could not match
    // and the run would fall through to 'denied'.
    assert.deepEqual(w.steps.map((s) => s.stepId), ['dj1', 'ok']);
    assert.equal(w.run.status, 'completed');

    const dj1 = w.steps.find((s) => s.stepId === 'dj1')!;
    assert.equal(dj1.context.steps!.dj1!.prUrl, 'https://pr/1');
    assert.equal(dj1.context.steps!.dj1!.status, 'done');
    assert.equal(dj1.actor?.kind, 'dev_job');
    assert.equal(dj1.actor?.jobId, 'job1');

    // The holding await was closed exactly once.
    const aw = await w.awaitStore.get((await w.port.awaitIdForJob('job1'))!);
    assert.equal(aw!.status, 'resolved');
  });

  for (const c of [
    { label: 'failed', outcome: { status: 'failed', error: 'apply failed' } },
    { label: 'cancelled', outcome: { status: 'cancelled' } },
    { label: 'gate/deny (failed + deny detail)', outcome: { status: 'failed', result: { outcome: 'failed', denied: true } } },
  ]) {
    it(`a terminal '${c.label}' outcome also resumes the run carrying that outcome (no crash, no hang)`, async () => {
      const w = makeWorld(graphBranch);
      await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

      const out = await w.executor.resolveDevJobAwait({ jobId: 'job1', ...c.outcome });

      // Resumed (did not hang) and branched down the fallback path (status != 'done').
      // FAIL-IF-REVERTED: a resolver that threw on a non-'done' outcome, or that never called
      // nextStep, would leave `steps` short of ['dj1','denied'] and the run not 'completed'.
      assert.deepEqual(w.steps.map((s) => s.stepId), ['dj1', 'denied']);
      assert.equal(w.run.status, 'completed');
      assert.equal(out?.status, 'completed');
      const dj1 = w.steps.find((s) => s.stepId === 'dj1')!;
      assert.equal(dj1.context.steps!.dj1!.status, c.outcome.status);
    });
  }
});

describe('dev-job step — idempotency (guarantee e)', () => {
  it('a duplicate terminal event resolves the await at most once (no double-advance)', async () => {
    const w = makeWorld(graphBranch);
    await w.executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    await w.executor.resolveDevJobAwait({ jobId: 'job1', status: 'done', prUrl: 'https://pr/1' });
    const stepsAfterFirst = w.steps.length;
    const statusAfterFirst = w.run.status;

    // Duplicate terminal event for the same job.
    await w.executor.resolveDevJobAwait({ jobId: 'job1', status: 'done', prUrl: 'https://pr/1' });

    // The second resolve is a no-op: the await is already 'resolved', so no new steps are
    // recorded and the run does not advance again.
    // FAIL-IF-REVERTED: dropping the `status !== 'waiting'` guard (or the atomic close CAS) would
    // let the duplicate re-run nextStep and re-record dj1, doubling the advance.
    assert.equal(w.steps.length, stepsAfterFirst);
    assert.equal(w.run.status, statusAfterFirst);
    assert.equal(w.steps.filter((s) => s.stepId === 'dj1').length, 1);
  });
});

describe('operator inbox excludes dev_job awaits (guarantee MEDIUM)', () => {
  // Behavioural fake Pool over an in-memory `conductor_awaits` table: it applies the query's own
  // channel_type predicate, so it faithfully proves the SQL filter — remove `<> 'dev_job'` from
  // listWaiting and the dev_job row leaks back into the result and the assertion fails.
  function awaitRow(id: string, channelType: string) {
    return {
      id, run_id: 'run1', step_id: id, principal_kind: channelType === 'dev_job' ? 'user' : 'role',
      principal_ref: channelType === 'dev_job' ? 'dev_job:job1' : 'approvers', channel_type: channelType,
      message: '', quorum: 'any', reminder_interval_ms: null, deadline_at: null,
      fallback_transition_id: null, status: 'waiting', unreachable: false, created_at: new Date(0),
    };
  }
  function makePool(rows: Array<ReturnType<typeof awaitRow>>) {
    return {
      async query(sql: string) {
        const waiting = rows.filter((r) => r.status === 'waiting');
        let out = waiting;
        if (/channel_type\s*<>\s*'dev_job'/.test(sql)) out = waiting.filter((r) => r.channel_type !== 'dev_job');
        else if (/channel_type\s*=\s*'dev_job'/.test(sql)) out = waiting.filter((r) => r.channel_type === 'dev_job');
        return { rows: out, rowCount: out.length };
      },
    };
  }

  it('listWaiting returns human awaits only; listWaitingDevJobAwaits returns the complement', async () => {
    const store = new ConductorAwaitStore(
      makePool([awaitRow('h1', 'teams'), awaitRow('dj1', 'dev_job')]) as never,
    );

    const inbox = await store.listWaiting();
    // FAIL-IF-REVERTED: dropping the `channel_type <> 'dev_job'` filter surfaces dj1 in the inbox.
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.stepId, 'h1');
    assert.ok(!inbox.some((a) => a.channelType === 'dev_job'));

    const sweep = await store.listWaitingDevJobAwaits();
    assert.equal(sweep.length, 1);
    assert.equal(sweep[0]!.channelType, 'dev_job');
    assert.equal(sweep[0]!.principalRef, 'dev_job:job1');
  });
});

describe('DevJobOutcomeEmitter + subscribeDevJobResolver', () => {
  it('emits terminal outcomes and filters non-terminal jobs (no premature resume)', () => {
    const emitter = new DevJobOutcomeEmitter();
    const seen: Array<{ jobId: string; status: string; prUrl?: string | null }> = [];
    emitter.onTerminal((o) => { seen.push(o); });

    // A still-running job must NOT be forwarded.
    // FAIL-IF-REVERTED: removing the isTerminalDevJobStatus guard forwards this → premature resume.
    emitter.emit({ id: 'job1', status: 'running', prUrl: null, branch: null, result: null, error: null } as never);
    assert.equal(seen.length, 0);

    emitter.emit({ id: 'job1', status: 'done', prUrl: 'https://pr/1', branch: 'b', result: { outcome: 'diff_ready' }, error: null } as never);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.jobId, 'job1');
    assert.equal(seen[0]!.status, 'done');
    assert.equal(seen[0]!.prUrl, 'https://pr/1');
  });

  it('routes terminal outcomes to the executor resolver and stops on unsubscribe', async () => {
    const emitter = new DevJobOutcomeEmitter();
    const calls: string[] = [];
    const resolver = { resolveDevJobAwait: async (o: { jobId: string }) => { calls.push(o.jobId); } };
    const unsub = subscribeDevJobResolver({ resolver, source: emitter });

    emitter.emit({ id: 'job2', status: 'failed', prUrl: null, branch: null, result: null, error: 'x' } as never);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['job2']);

    // After unsubscribe, no further delivery.
    // FAIL-IF-REVERTED: an onTerminal that ignored its returned disposer would keep delivering.
    unsub();
    emitter.emit({ id: 'job3', status: 'done', prUrl: null, branch: null, result: null, error: null } as never);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['job2']);
  });
});
