import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import { createDevWebhooksRouter, type DevWebhooksRouterDeps } from '../../src/routes/devWebhooks.js';
import {
  createTriggerJob,
  type CreateTriggerJobInput,
  type TriggerGateOpenInput,
  type TriggerGateStore,
  type TriggerJobStore,
} from '../../src/devplatform/triggers/triggerJobService.js';
import type { DevJob, DevRepo } from '../../src/devplatform/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'whsec_unit_test_secret';

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function repo(over: Partial<DevRepo> = {}): DevRepo {
  return {
    id: 'repo-1',
    forgeKind: 'github',
    owner: 'byte5ai',
    name: 'omadia',
    cloneUrl: 'https://github.com/byte5ai/omadia.git',
    defaultBranch: 'main',
    credentialKind: 'github_app',
    credentialRef: 'repo/repo-1',
    trackerKind: null,
    trackerConfig: {},
    allowedTriggers: ['admin', 'webhook'],
    allowedLaunchers: [],
    egressAllowlist: [],
    runsTests: true,
    branchProtectionOk: true,
    branchProtectionCheckedAt: null,
    approverRoleKey: null,
    gateDeadlineIso: 'P7D',
    bootstrapCommand: null,
    testCommand: null,
    policyOverrides: {},
    triggerLabel: 'omadia-dev',
    webhookEnabled: true,
    webhookSenders: ['alice'],
    createdBy: 'user-1',
    createdAt: '2026-07-11T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
    ...over,
  };
}

interface PayloadParts {
  action?: unknown;
  label?: unknown;
  issue?: unknown;
  repository?: unknown;
  sender?: unknown;
}

function issuesBody(over: PayloadParts = {}): string {
  return JSON.stringify({
    action: 'labeled',
    label: { name: 'omadia-dev' },
    issue: { number: 42, title: 'Fix the thing', body: 'It is broken' },
    repository: { full_name: 'byte5ai/omadia' },
    sender: { login: 'alice' },
    ...over,
  });
}

// In-memory delivery ledger implementing DevWebhooksDeliveryStore.
function fakeDeliveries() {
  const rows = new Map<string, { repo: string | null; sender: string | null; outcome: string; at: number }>();
  let auto = 0;
  const store: DevWebhooksRouterDeps['deliveries'] = {
    claim: async (i) => {
      if (rows.has(i.deliveryId)) return false;
      rows.set(i.deliveryId, { repo: i.repo, sender: i.sender, outcome: 'received', at: Date.now() });
      return true;
    },
    setOutcome: async (id, o) => {
      const r = rows.get(id);
      if (r) r.outcome = o;
    },
    // Single-threaded in-memory mirror of the real advisory-locked reservation:
    // count committed `job_created` rows in the window, then stamp THIS delivery.
    reserveJobSlot: async ({ repo, sender, deliveryId, repoLimit, senderLimit, sinceIso }) => {
      const since = Date.parse(sinceIso);
      const repoCount = [...rows.values()].filter(
        (x) => x.repo === repo && x.outcome === 'job_created' && x.at >= since,
      ).length;
      const senderCount = [...rows.values()].filter(
        (x) => x.repo === repo && x.sender === sender && x.outcome === 'job_created' && x.at >= since,
      ).length;
      const row = rows.get(deliveryId);
      if (repoCount >= repoLimit || senderCount >= senderLimit) {
        if (row) row.outcome = 'rate_limited';
        return { admitted: false, reason: 'rate_limited' };
      }
      if (row) row.outcome = 'job_created';
      return { admitted: true };
    },
    hasPriorJob: async (r, s) =>
      [...rows.values()].some((x) => x.repo === r && x.sender === s && x.outcome === 'job_created'),
  };
  const seedJobCreated = (r: string, s: string, n: number): void => {
    for (let k = 0; k < n; k++) rows.set(`seed-${auto++}`, { repo: r, sender: s, outcome: 'job_created', at: Date.now() });
  };
  return { rows, store, seedJobCreated };
}

async function routeHarness(over: Partial<DevWebhooksRouterDeps> = {}) {
  const del = fakeDeliveries();
  const reposMap = new Map<string, DevRepo>([['byte5ai/omadia', repo()]]);
  const createCalls: CreateTriggerJobInput[] = [];
  const deps: DevWebhooksRouterDeps = {
    listWebhookSecrets: async () => [SECRET],
    repos: { getByFullName: async (fn) => reposMap.get(fn) ?? null },
    deliveries: del.store,
    hasActiveWebhookJob: async () => false,
    createTriggerJob: async (input) => {
      createCalls.push(input);
      return { decision: 'created', job: { id: 'job-1' } as unknown as DevJob, gated: input.requireGate };
    },
    mintRunnerToken: () => ({ token: 't', hash: 'h' }),
    webhookBackend: 'docker',
    webhooksEnabled: true,
    maxJobsPerRepoHour: 5,
    maxJobsPerSenderHour: 2,
    // Real clock so seeded `job_created` rows (stamped with Date.now()) fall inside
    // the route's rolling-hour window; the rate-limit maths is what's under test.
    now: () => Date.now(),
    log: () => {},
    ...over,
  };
  const app = express();
  app.use(createDevWebhooksRouter(deps));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    del,
    reposMap,
    createCalls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface PostOpts {
  secret?: string | null;
  event?: string;
  delivery?: string;
  extraApp?: express.Express;
}

async function post(
  base: string,
  body: string,
  opts: PostOpts = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event ?? 'issues',
    'x-github-delivery': opts.delivery ?? `d-${crypto.randomUUID()}`,
  };
  if (secret !== null) headers['x-hub-signature-256'] = sign(secret, body);
  const res = await fetch(`${base}/api/webhooks/github`, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Route behaviour
// ---------------------------------------------------------------------------

describe('devWebhooks route', () => {
  it('valid signature + labeled + allowed sender → job created', async () => {
    // FAIL-IF-REVERTED: the happy path must create a source='webhook' job with the
    // '<repo>#<issue>' source_ref and 'webhook:github' creator, and record 'job_created'.
    const h = await routeHarness();
    try {
      const delivery = 'gd-happy';
      const r = await post(h.base, issuesBody(), { delivery });
      assert.equal(r.status, 201);
      assert.equal(r.json['outcome'], 'job_created');
      assert.equal(r.json['jobId'], 'job-1');
      assert.equal(h.createCalls.length, 1);
      assert.equal(h.createCalls[0]!.source, 'webhook');
      assert.equal(h.createCalls[0]!.sourceRef, 'byte5ai/omadia#42');
      assert.equal(h.createCalls[0]!.createdBy, 'webhook:github');
      assert.equal(h.createCalls[0]!.kind, 'fix_issue');
      assert.equal(h.del.rows.get(delivery)?.outcome, 'job_created');
    } finally {
      await h.close();
    }
  });

  it('bad signature → 401 and no job, nothing recorded', async () => {
    // FAIL-IF-REVERTED: an unverified payload must never create a job or leave a row.
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody(), { secret: 'wrong-secret' });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.bad_signature');
      assert.equal(h.createCalls.length, 0);
      assert.equal(h.del.rows.size, 0);
    } finally {
      await h.close();
    }
  });

  it('missing signature header → 401', async () => {
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody(), { secret: null });
      assert.equal(r.status, 401);
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('wrong event → 202 drop, no job', async () => {
    // FAIL-IF-REVERTED: valid-signature non-issue events must be dropped with 2xx (no retry storm).
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody(), { event: 'push' });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'dropped_event');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('wrong action → 202 drop', async () => {
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody({ action: 'opened' }));
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'dropped_event');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('wrong label → 202 dropped_label', async () => {
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody({ label: { name: 'bug' } }));
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'dropped_label');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('repo without webhook in allowed_triggers → 202 dropped_repo', async () => {
    const h = await routeHarness();
    h.reposMap.set('byte5ai/omadia', repo({ allowedTriggers: ['admin'] }));
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'dropped_repo');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('sender not in webhook_senders → 202 refused_sender, no job', async () => {
    // FAIL-IF-REVERTED: a labeled-issue from a non-allowlisted sender must never spawn a job (S7).
    const h = await routeHarness();
    try {
      const r = await post(h.base, issuesBody({ sender: { login: 'mallory' } }));
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'refused_sender');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('empty webhook_senders → refused_sender (webhook off for repo)', async () => {
    const h = await routeHarness();
    h.reposMap.set('byte5ai/omadia', repo({ webhookSenders: [] }));
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.json['outcome'], 'refused_sender');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('per-repo rate limit exceeded → 202 rate_limited, no job', async () => {
    // FAIL-IF-REVERTED: >5 jobs/repo/hour must be refused without creating a job.
    const h = await routeHarness();
    h.del.seedJobCreated('byte5ai/omadia', 'bob', 5); // 5 already this hour (repo cap = 5)
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'rate_limited');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('per-sender rate limit exceeded → 202 rate_limited', async () => {
    const h = await routeHarness();
    h.del.seedJobCreated('byte5ai/omadia', 'alice', 2); // sender cap = 2
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.json['outcome'], 'rate_limited');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('duplicate delivery GUID → 202 duplicate, only one job', async () => {
    // FAIL-IF-REVERTED: a redelivered GUID must not create a second job.
    const h = await routeHarness();
    try {
      const first = await post(h.base, issuesBody(), { delivery: 'dup-1' });
      assert.equal(first.status, 201);
      const second = await post(h.base, issuesBody(), { delivery: 'dup-1' });
      assert.equal(second.status, 202);
      assert.equal(second.json['outcome'], 'duplicate');
      assert.equal(h.createCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  it('active job for repo+ref → 202 deduped_active_job', async () => {
    // FAIL-IF-REVERTED: label remove/re-add while a job runs must not double-launch.
    const h = await routeHarness({ hasActiveWebhookJob: async () => true });
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'deduped_active_job');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('structural refusal (service returns refused_policy) → 202 refused_policy, no job persisted', async () => {
    // FAIL-IF-REVERTED: a job the service refuses must record refused_policy and no job.
    const h = await routeHarness({
      createTriggerJob: async () => ({ decision: 'refused_policy', gated: false, reason: 'local backend' }),
    });
    try {
      const delivery = 'refuse-1';
      const r = await post(h.base, issuesBody(), { delivery });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'refused_policy');
      assert.equal(h.del.rows.get(delivery)?.outcome, 'refused_policy');
    } finally {
      await h.close();
    }
  });

  it('global kill switch off → 202 disabled', async () => {
    // FAIL-IF-REVERTED: DEV_WEBHOOKS_ENABLED=false must stop all job creation.
    const h = await routeHarness({ webhooksEnabled: false });
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'disabled');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('per-repo webhook_enabled=false → 202 disabled', async () => {
    const h = await routeHarness();
    h.reposMap.set('byte5ai/omadia', repo({ webhookEnabled: false }));
    try {
      const r = await post(h.base, issuesBody());
      assert.equal(r.json['outcome'], 'disabled');
      assert.equal(h.createCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('first job from a new (repo,sender) pair requests a gate; the next does not', async () => {
    // FAIL-IF-REVERTED: the first delivery from a pair must set requireGate=true.
    const h = await routeHarness();
    try {
      const first = await post(h.base, issuesBody(), { delivery: 'p-1' });
      assert.equal(first.json['gated'], true);
      assert.equal(h.createCalls[0]!.requireGate, true);

      // The first delivery recorded job_created for (repo, alice); the second is no longer first.
      const second = await post(h.base, issuesBody(), { delivery: 'p-2' });
      assert.equal(second.json['gated'], false);
      assert.equal(h.createCalls[1]!.requireGate, false);
    } finally {
      await h.close();
    }
  });

  it('raw-body ordering regression: express.json mounted BEFORE the router breaks the signature', async () => {
    // FAIL-IF-REVERTED: this proves the mount-before-express.json contract. If the
    // router were mounted after a JSON body parser, the raw bytes are gone and a
    // correctly-signed delivery fails to verify → 401.
    const del = fakeDeliveries();
    const deps: DevWebhooksRouterDeps = {
      listWebhookSecrets: async () => [SECRET],
      repos: { getByFullName: async () => repo() },
      deliveries: del.store,
      hasActiveWebhookJob: async () => false,
      createTriggerJob: async () => ({ decision: 'created', job: { id: 'j' } as unknown as DevJob, gated: false }),
      mintRunnerToken: () => ({ token: 't', hash: 'h' }),
      webhookBackend: 'docker',
      webhooksEnabled: true,
      maxJobsPerRepoHour: 5,
      maxJobsPerSenderHour: 2,
      log: () => {},
    };
    const app = express();
    app.use(express.json()); // WRONG ORDER — consumes the raw bytes first.
    app.use(createDevWebhooksRouter(deps));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await post(`http://127.0.0.1:${port}`, issuesBody());
      assert.equal(r.status, 401, 'signature must fail when the JSON parser ate the raw body');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('real boot order: router mounted BEFORE express.json → signed delivery verifies AND sibling json routes still parse', async () => {
    // FAIL-IF-REVERTED: this mirrors the EXACT mount order index.ts uses — the raw-body
    // webhook router first, the global express.json parser after. It proves both halves
    // of the contract at once: (a) a correctly-signed delivery still reaches the raw
    // parser and verifies (NOT 401); (b) the global json parser mounted AFTER the router
    // still parses OTHER routes' bodies (the webhook mount must not starve them).
    const del = fakeDeliveries();
    const deps: DevWebhooksRouterDeps = {
      listWebhookSecrets: async () => [SECRET],
      repos: { getByFullName: async () => repo() },
      deliveries: del.store,
      hasActiveWebhookJob: async () => false,
      createTriggerJob: async () => ({ decision: 'created', job: { id: 'j' } as unknown as DevJob, gated: false }),
      mintRunnerToken: () => ({ token: 't', hash: 'h' }),
      webhookBackend: 'docker',
      webhooksEnabled: true,
      maxJobsPerRepoHour: 5,
      maxJobsPerSenderHour: 2,
      log: () => {},
    };
    const app = express();
    app.use(createDevWebhooksRouter(deps)); // CORRECT ORDER — raw body first.
    app.use(express.json());
    app.post('/echo', (req, res) => {
      res.json({ got: (req.body as { n?: number }).n ?? null });
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // (a) the signed webhook delivery verifies through the router's raw parser.
      const r = await post(base, issuesBody());
      assert.equal(r.status, 201, 'a correctly-signed delivery must verify when mounted before express.json');
      assert.equal(r.json['outcome'], 'job_created');
      // (b) the global json parser still parses a sibling route mounted after it.
      const echo = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 7 }),
      });
      assert.equal(((await echo.json()) as { got: number }).got, 7);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Trigger job-creation service (structural refusals + first-source gate)
// ---------------------------------------------------------------------------

function jobStoreFake() {
  const calls = {
    create: [] as Array<Parameters<TriggerJobStore['createJob']>[0]>,
  };
  const store: TriggerJobStore = {
    createJob: async (i) => {
      calls.create.push(i);
      return { id: 'job-1' } as unknown as DevJob;
    },
  };
  return { calls, store };
}

function gateStoreFake() {
  const opened: TriggerGateOpenInput[] = [];
  const store: TriggerGateStore = {
    open: async (i) => {
      opened.push(i);
      return { id: 'gate-1' };
    },
  };
  return { opened, store };
}

function svcInput(over: Partial<CreateTriggerJobInput> = {}): CreateTriggerJobInput {
  return {
    repo: repo(),
    backend: 'docker',
    kind: 'fix_issue',
    brief: 'title\n\nbody',
    sourceRef: 'byte5ai/omadia#42',
    source: 'webhook',
    createdBy: 'webhook:github',
    runnerTokenHash: 'h',
    requireGate: false,
    senderLogin: 'alice',
    ...over,
  };
}

describe('createTriggerJob (structural policy)', () => {
  it('refuses local backend → no job created', async () => {
    // FAIL-IF-REVERTED: a trigger job may never run on the shared-host local backend.
    const js = jobStoreFake();
    const gs = gateStoreFake();
    const r = await createTriggerJob({ jobStore: js.store, gateStore: gs.store }, svcInput({ backend: 'local' }));
    assert.equal(r.decision, 'refused_policy');
    assert.equal(js.calls.create.length, 0);
  });

  it('refuses device_flow repo → no job created', async () => {
    const js = jobStoreFake();
    const gs = gateStoreFake();
    const r = await createTriggerJob(
      { jobStore: js.store, gateStore: gs.store },
      svcInput({ repo: repo({ credentialKind: 'device_flow' }) }),
    );
    assert.equal(r.decision, 'refused_policy');
    assert.equal(js.calls.create.length, 0);
  });

  it('refuses webhook job on a non-github_app repo → no job created', async () => {
    // FAIL-IF-REVERTED: the webhook secret only exists in github_app mode.
    const js = jobStoreFake();
    const gs = gateStoreFake();
    const r = await createTriggerJob(
      { jobStore: js.store, gateStore: gs.store },
      svcInput({ repo: repo({ credentialKind: 'pat' }) }),
    );
    assert.equal(r.decision, 'refused_policy');
    assert.equal(js.calls.create.length, 0);
  });

  it('github_app + requireGate=false → job created queued (unset status), no gate opened', async () => {
    const js = jobStoreFake();
    const gs = gateStoreFake();
    const r = await createTriggerJob({ jobStore: js.store, gateStore: gs.store }, svcInput());
    assert.equal(r.decision, 'created');
    assert.equal(r.gated, false);
    assert.equal(js.calls.create.length, 1);
    // A non-gated job carries no explicit status → the store defaults it to 'queued'.
    assert.equal(js.calls.create[0]!.status, undefined);
    assert.equal(gs.opened.length, 0);
  });

  it('first job from a new source (requireGate=true) is BORN parked and then a review gate opens', async () => {
    // FAIL-IF-REVERTED: the first job from a new source must be held at a human gate
    // BEFORE the agent runs. The fix creates it DIRECTLY as status='waiting',
    // phase='await_human' in the single INSERT (never a transient 'queued' the claim
    // loop could grab), then opens the 'review' gate over the already-parked job.
    const js = jobStoreFake();
    const gs = gateStoreFake();
    const r = await createTriggerJob(
      { jobStore: js.store, gateStore: gs.store },
      svcInput({ requireGate: true }),
    );
    assert.equal(r.decision, 'created');
    assert.equal(r.gated, true);
    assert.equal(js.calls.create.length, 1);
    assert.equal(js.calls.create[0]!.status, 'waiting');
    assert.equal(js.calls.create[0]!.phase, 'await_human');
    assert.equal(gs.opened.length, 1);
    assert.equal(gs.opened[0]!.gateKind, 'review');
    assert.equal(gs.opened[0]!.principalKind, 'user');
    assert.equal(gs.opened[0]!.principalRef, 'user-1');
  });

  it('first-source gate targets the approver role when the repo sets one', async () => {
    const js = jobStoreFake();
    const gs = gateStoreFake();
    await createTriggerJob(
      { jobStore: js.store, gateStore: gs.store },
      svcInput({ requireGate: true, repo: repo({ approverRoleKey: 'dev-approvers' }) }),
    );
    assert.equal(gs.opened[0]!.principalKind, 'role');
    assert.equal(gs.opened[0]!.principalRef, 'dev-approvers');
  });
});
