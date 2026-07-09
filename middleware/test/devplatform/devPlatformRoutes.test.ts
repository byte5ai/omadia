/**
 * Epic #470 W0 — admin REST + SSE (`/api/v1/admin/dev-platform`, spec §9).
 * Covers the launcher gate, the auth-mode and local-backend admission checks,
 * credential non-leakage, and SSE replay across a provision boundary. The
 * shared fakes live in devPlatformRoutes.harness.ts (500-line rule).
 */

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  assertAuthModeAdmissible,
  assertLocalBackendAdmissible,
} from '../../src/routes/devPlatformShared.js';

import {
  DEVICE_TOKEN,
  Harness,
  PAT_TOKEN,
  authHeaders,
  hasLeakedSecret,
  makeHarness,
  makeJob,
  makeRepo,
  postJson,
  throwsCode,
} from './devPlatformRoutes.harness.js';

describe('devPlatform — session gate', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('401 without a session', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/jobs`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.unauthorized');
  });

  it('200 with a session', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/jobs`, { headers: authHeaders() });
    assert.equal(res.status, 200);
  });
});

describe('devPlatform — launch authorization', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('403 for a caller who is neither creator nor a permitted launcher', async () => {
    h = await makeHarness();
    h.repoStore.add(makeRepo({ createdBy: 'alice', allowedLaunchers: [] }));
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('bob'), {
      repoId: 'repo-1', kind: 'implement', backend: 'local', brief: 'x',
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.not_launcher');
  });

  it('allows the creator', async () => {
    h = await makeHarness();
    h.repoStore.add(makeRepo({ createdBy: 'alice', runsTests: false }));
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('alice'), {
      repoId: 'repo-1', kind: 'implement', backend: 'local', brief: 'x',
    });
    assert.equal(res.status, 201);
  });

  it('allows a caller holding an allowed_launchers role key', async () => {
    h = await makeHarness();
    h.repoStore.add(makeRepo({ createdBy: 'alice', allowedLaunchers: ['admin'], runsTests: false }));
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('bob', 'admin'), {
      repoId: 'repo-1', kind: 'implement', backend: 'local', brief: 'x',
    });
    assert.equal(res.status, 201);
  });
});

describe('devPlatform — POST /repos onboarding', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('validates access via the forge probe, captures default_branch, runs the protection check', async () => {
    h = await makeHarness();
    const res = await postJson(`${h.baseUrl}/repos`, authHeaders('alice'), {
      owner: 'o', name: 'r', credential: { kind: 'pat', token: PAT_TOKEN }, runsTests: false,
    });
    assert.equal(res.status, 201);
    const raw = await res.text();
    assert.ok(!raw.includes(PAT_TOKEN), 'PAT must never appear in the response');
    const view = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(view['defaultBranch'], 'develop', 'default_branch captured from the probe');
    assert.deepEqual(Object.keys(view['credential'] as object).sort(), ['isSet', 'kind', 'login']);
    assert.equal((view['credential'] as { isSet: boolean }).isSet, true);
    assert.equal(hasLeakedSecret(view), false);
    // Probe called with the supplied token; branch-protection persisted.
    assert.equal(h.probeCalls[0]?.token, PAT_TOKEN);
    assert.equal(h.repoStore.branchProtectionCalls[0]?.ok, true);
  });

  it('400 when the probe denies access', async () => {
    h = await makeHarness({ probeRepoAccess: async () => ({ ok: false, defaultBranch: '' }) });
    const res = await postJson(`${h.baseUrl}/repos`, authHeaders('alice'), {
      owner: 'o', name: 'r', credential: { kind: 'pat', token: PAT_TOKEN },
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.repo_access_failed');
  });

  it('promotes a staged device-flow token', async () => {
    h = await makeHarness();
    await h.credentials.stashPending('alice', DEVICE_TOKEN);
    const res = await postJson(`${h.baseUrl}/repos`, authHeaders('alice'), {
      owner: 'o', name: 'r', credential: { kind: 'device_flow' },
    });
    assert.equal(res.status, 201);
    const raw = await res.text();
    assert.ok(!raw.includes(DEVICE_TOKEN));
    // Token moved onto the repo row; pending cleared.
    const created = [...h.repoStore.repos.values()].find((r) => r.id.startsWith('repo-new'));
    assert.ok(created);
    assert.equal(await h.credentials.resolve(created!.id), DEVICE_TOKEN);
    assert.equal(await h.credentials.resolvePending('alice'), undefined);
  });
});

describe('devPlatform — POST /jobs brief composition', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('composes the brief through briefComposer when issueNumber is given', async () => {
    h = await makeHarness();
    h.repoStore.add(makeRepo({ createdBy: 'alice', runsTests: false }));
    h.credentials.tokens.set('repo-1', PAT_TOKEN);
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('alice'), {
      repoId: 'repo-1', kind: 'fix_issue', backend: 'local', issueNumber: 123,
    });
    assert.equal(res.status, 201);
    const created = h.jobStore.created[0]!;
    assert.deepEqual(h.trackerCalls, [123]);
    assert.equal(created.sourceRef, 'gh-issue:123');
    assert.match(created.brief, /BEGIN UNTRUSTED TICKET TEXT/);
    assert.match(created.brief, /Login button is broken/);
    assert.match(created.brief, /It throws on click\./);
  });
});

describe('devPlatform — admission guards', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it("local backend refused for a runs_tests repo (route)", async () => {
    h = await makeHarness();
    h.repoStore.add(makeRepo({ createdBy: 'alice', runsTests: true }));
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('alice'), {
      repoId: 'repo-1', kind: 'implement', backend: 'local', brief: 'x',
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.local_backend_requires_no_exec');
  });

  it('local backend refused for a non-admin source (guard)', () => {
    throwsCode(
      () => assertLocalBackendAdmissible({ backend: 'local', source: 'chat' }, { runsTests: false }),
      'devplatform.local_backend_admin_only',
    );
    // admin + no-exec is admissible.
    assert.doesNotThrow(() => assertLocalBackendAdmissible({ backend: 'local', source: 'admin' }, { runsTests: false }));
  });

  it('subscription refused in each of the four cases (guard)', () => {
    const base = { authMode: 'subscription' as const, source: 'admin' as const, backend: 'local' as const };
    const repoOk = { runsTests: false };
    // 1) mode flag off
    throwsCode(() => assertAuthModeAdmissible(base, repoOk, { subscriptionModeEnabled: false }), 'devplatform.subscription_disabled');
    // 2) repo executes tests
    throwsCode(() => assertAuthModeAdmissible(base, { runsTests: true }, { subscriptionModeEnabled: true }), 'devplatform.subscription_requires_no_exec');
    // 3) non-admin source
    throwsCode(() => assertAuthModeAdmissible({ ...base, source: 'chat' }, repoOk, { subscriptionModeEnabled: true }), 'devplatform.subscription_operator_only');
    // 4) fly backend
    throwsCode(() => assertAuthModeAdmissible({ ...base, backend: 'fly' }, repoOk, { subscriptionModeEnabled: true }), 'devplatform.subscription_backend_unsupported');
    // all clear
    assert.doesNotThrow(() => assertAuthModeAdmissible(base, repoOk, { subscriptionModeEnabled: true }));
  });

  it('subscription refused at the route when the mode flag is off', async () => {
    h = await makeHarness({ subscriptionModeEnabled: false });
    h.repoStore.add(makeRepo({ createdBy: 'alice', runsTests: false }));
    const res = await postJson(`${h.baseUrl}/jobs`, authHeaders('alice'), {
      repoId: 'repo-1', kind: 'implement', backend: 'docker', brief: 'x', authMode: 'subscription',
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.subscription_disabled');
  });
});

describe('devPlatform — job views carry no secret', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('GET /jobs/:id omits the runner-token hash and any credential key', async () => {
    h = await makeHarness();
    h.jobStore.add(makeJob({ id: 'job-1', runnerTokenHash: 'HASH-DO-NOT-LEAK' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes('HASH-DO-NOT-LEAK'), 'runner-token hash must not leak');
    assert.equal(hasLeakedSecret(JSON.parse(raw)), false);
  });
});

describe('devPlatform — cancel routes through finalizeDevJob', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  it('202 and hits the single choke point', async () => {
    h = await makeHarness();
    h.jobStore.add(makeJob({ id: 'job-1', status: 'queued' }));
    const res = await postJson(`${h.baseUrl}/jobs/job-1/cancel`, authHeaders(), {});
    assert.equal(res.status, 202);
    assert.equal(h.finalizeCalls.length, 1);
    assert.equal(h.finalizeCalls[0]?.status, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// SSE — the single job-event tail.
// ---------------------------------------------------------------------------

interface SseFrame { id?: string; event?: string; data?: string }

function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue;
    const f: SseFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) f.id = line.slice(4);
      else if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('data: ')) f.data = line.slice(6);
    }
    if (f.id || f.event || f.data) frames.push(f);
  }
  return frames;
}

async function collectSse(
  url: string,
  headers: Record<string, string>,
  afterConnect: () => void,
): Promise<{ raw: string; frames: SseFrame[]; contentType: string; cacheControl: string; accelBuffering: string }> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const contentType = res.headers.get('content-type') ?? '';
  const cacheControl = res.headers.get('cache-control') ?? '';
  const accelBuffering = res.headers.get('x-accel-buffering') ?? '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let fired = false;
  const readLoop = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (!fired && raw.includes(': connected')) {
        fired = true;
        setTimeout(afterConnect, 20);
      }
    }
  })();
  await Promise.race([readLoop, new Promise((r) => setTimeout(r, 1500))]);
  controller.abort();
  return { raw, frames: parseSse(raw), contentType, cacheControl, accelBuffering };
}

describe('devPlatform — GET /jobs/:id/events (SSE)', () => {
  let h: Harness;
  afterEach(async () => { if (h) await h.close(); });

  function ev(id: number, provision: number, seq: number, extra: Partial<DevJobEvent> = {}): DevJobEvent {
    return { id, jobId: 'job-1', provision, seq, type: 'log', ts: new Date().toISOString(), payload: {}, ...extra };
  }

  it('sets the SSE headers, replays after Last-Event-ID across a provision boundary, and delivers a live event', async () => {
    h = await makeHarness();
    h.jobStore.add(makeJob({ id: 'job-1', status: 'running' }));
    // Two provisions; ids are monotonic across them, seq collides (0,1 each).
    h.jobStore.addEvent(ev(1, 1, 0));
    h.jobStore.addEvent(ev(2, 1, 1));
    h.jobStore.addEvent(ev(3, 2, 0)); // provision 2, seq 0 — distinct id
    h.jobStore.addEvent(ev(4, 2, 1));

    const out = await collectSse(`${h.baseUrl}/jobs/job-1/events`, { ...authHeaders(), 'last-event-id': '2' }, () => {
      // A live event from provision 2, then a terminal status event that ends it.
      h.eventBus.publish('job-1', ev(5, 2, 2, { type: 'tool' }));
      h.eventBus.publish('job-1', ev(6, 2, 3, { type: 'status', payload: { status: 'done' } }));
    });

    assert.match(out.contentType, /text\/event-stream/);
    assert.equal(out.cacheControl, 'no-cache, no-transform');
    assert.equal(out.accelBuffering, 'no');

    const ids = out.frames.filter((f) => f.id).map((f) => Number(f.id));
    // Replay skipped ids 1,2 (<= Last-Event-ID); resumed at 3,4 across the
    // provision boundary; live 5,6 arrived; nothing lost, nothing regressed.
    assert.deepEqual(ids, [3, 4, 5, 6]);
    // `id:` is the events-table id, never seq — seq for id 3 was 0, id 4 was 1.
    const frame3 = out.frames.find((f) => f.id === '3')!;
    assert.equal((JSON.parse(frame3.data!) as DevJobEvent).seq, 0);
    // Terminal status event ended the stream.
    assert.ok(out.frames.some((f) => f.event === 'status' && /"status":"done"/.test(f.data ?? '')));
  });

  it('404 for an unknown job', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/jobs/nope/events`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  });
});
