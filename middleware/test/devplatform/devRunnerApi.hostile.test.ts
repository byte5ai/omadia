import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  makeHarness,
  makeJob,
  auth,
  CLONE_TOKEN,
  VALID,
  type Harness,
} from './devRunnerApi.harness.js';

/**
 * Regression guards for the findings of the adversarial review of commit 9bc5f6c.
 * Each of these passed the original implementation; each is a way a hostile
 * runner defeats a guarantee this router exists to provide.
 */
describe('devRunnerApi — hostile runner', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function post(path: string, body: unknown, headers = auth()): Promise<Response> {
    return fetch(`${h.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('refuses a diffArtifactId belonging to another job', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ id: 'job-1', status: 'running' }), VALID);
    h.store.add(makeJob({ id: 'job-2', status: 'running' }), 'djr_other');
    const foreign = await h.store.addArtifact('job-2', 'diff', 'diff --git a/x b/x\n');

    const res = await post('/jobs/job-1/result', { outcome: 'diff_ready', diffArtifactId: foreign });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.unknown_artifact');
    // job-1 must NOT be carrying job-2's diff into the host-side apply.
    assert.equal(h.store.jobs.get('job-1')!.status, 'running');
    assert.equal(h.store.recorded.length, 0);
  });

  it('refuses diff_ready without a diffArtifactId', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await post('/jobs/job-1/result', { outcome: 'diff_ready' });
    assert.equal(res.status, 400);
    assert.equal(h.store.jobs.get('job-1')!.status, 'running');
  });

  it('issues the clone credential exactly once under concurrency', async () => {
    // A check-then-await-then-add guard loses this race: resolve() is a Vault
    // round-trip, so both requests pass the check before either records it.
    let resolveCalls = 0;
    h = await makeHarness({
      scmTokens: {
        resolve: async (): Promise<string> => {
          resolveCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return CLONE_TOKEN;
        },
      },
    });
    h.store.add(makeJob({ status: 'running' }));

    const [a, b] = await Promise.all([
      fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() }),
      fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(resolveCalls, 1);
  });

  it('rejects an unauthenticated oversized diff before buffering the body', async () => {
    h = await makeHarness({ maxDiffBytes: 1024 });
    h.store.add(makeJob({ status: 'running' }));
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const res = await fetch(`${h.baseUrl}/jobs/job-1/diff`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer wrong' },
      body: huge,
    });
    // 401 from the auth gate, not 413 from the parser: auth runs first.
    assert.equal(res.status, 401);
    assert.equal(h.store.artifacts.length, 0);
  });

  it('bounds seq and caps a single event payload', async () => {
    h = await makeHarness({ maxEventPayloadBytes: 128 });
    h.store.add(makeJob({ status: 'running' }));

    const tooBig = await post('/jobs/job-1/events', {
      provision: 1,
      events: [{ seq: 0, type: 'log', payload: { text: 'y'.repeat(500) } }],
    });
    assert.equal(tooBig.status, 413);

    const tooLarge = await post('/jobs/job-1/events', {
      provision: 1,
      events: [{ seq: 2 ** 53, type: 'log' }],
    });
    assert.equal(tooLarge.status, 400);
    assert.equal(h.store.events.length, 0);
  });
});
