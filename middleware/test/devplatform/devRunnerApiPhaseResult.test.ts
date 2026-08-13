import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { StalePhaseError, type PhaseDirective, type PhaseResultInput } from '../../src/devplatform/pipeline/phaseEngine.js';
import type { DevJob } from '../../src/devplatform/types.js';
import { auth, makeHarness, makeJob, VALID, type Harness } from './devRunnerApi.harness.js';

/** Spy handler: records the input, returns a scripted directive or throws. */
function spyHandler() {
  const calls: Array<{ jobId: string; input: PhaseResultInput }> = [];
  let next: PhaseDirective | Error = { directive: 'next', phase: 'review' };
  const fn = async (job: DevJob, input: PhaseResultInput): Promise<PhaseDirective> => {
    calls.push({ jobId: job.id, input });
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    fn,
    calls,
    respond(d: PhaseDirective) {
      next = d;
    },
    throwStale() {
      next = new StalePhaseError('job-1', 'analyze', 'implement');
    },
  };
}

async function seed(h: Harness): Promise<void> {
  const job = makeJob({ id: 'job-1', status: 'running', phase: 'implement' });
  h.store.jobs.set(job.id, job);
  h.store.tokens.set(job.id, VALID);
}

describe('devRunnerApi — POST /jobs/:id/phase-result', () => {
  it('forwards a well-formed result and returns the directive', async () => {
    const spy = spyHandler();
    const h = await makeHarness({ handlePhaseResult: spy.fn });
    after(() => h.close());
    await seed(h);
    spy.respond({ directive: 'next', phase: 'review' });

    const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: 'implement',
        ok: true,
        artifact: { kind: 'diff', content: 'a diff', meta: { headSha: 'abc' } },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { directive: 'next', phase: 'review' });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.input.artifact?.kind, 'diff');
  });

  it('maps a StalePhaseError to 409', async () => {
    const spy = spyHandler();
    const h = await makeHarness({ handlePhaseResult: spy.fn });
    after(() => h.close());
    await seed(h);
    spy.throwStale();

    const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'analyze', ok: true }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { code: string }).code, 'devplatform.stale_phase');
  });

  it('rejects a missing or unknown phase with 400', async () => {
    const spy = spyHandler();
    const h = await makeHarness({ handlePhaseResult: spy.fn });
    after(() => h.close());
    await seed(h);

    for (const phase of [undefined, 'nonsense', 42]) {
      const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ phase, ok: true }),
      });
      assert.equal(res.status, 400, `phase=${JSON.stringify(phase)} must 400`);
    }
    assert.equal(spy.calls.length, 0, 'a bad phase never reaches the engine');
  });

  it('rejects a non-boolean ok with 400', async () => {
    const spy = spyHandler();
    const h = await makeHarness({ handlePhaseResult: spy.fn });
    after(() => h.close());
    await seed(h);
    const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'implement', ok: 'yes' }),
    });
    assert.equal(res.status, 400);
  });

  it('requires the job bearer — no token is 401', async () => {
    const spy = spyHandler();
    const h = await makeHarness({ handlePhaseResult: spy.fn });
    after(() => h.close());
    await seed(h);
    const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'implement', ok: true }),
    });
    assert.equal(res.status, 401);
    assert.equal(spy.calls.length, 0);
  });

  it('is not mounted when no handler is wired (W0/collapsed shape)', async () => {
    const h = await makeHarness(); // no handlePhaseResult
    after(() => h.close());
    await seed(h);
    const res = await fetch(`${h.baseUrl}/jobs/job-1/phase-result`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'implement', ok: true }),
    });
    assert.equal(res.status, 404, 'the endpoint simply does not exist');
  });
});
