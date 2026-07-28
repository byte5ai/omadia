import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import express, { type RequestHandler } from 'express';

import { createDevPlatformGatesRouter, type DevPlatformGatesDeps } from '../../src/routes/devPlatformGates.js';
import type { DevJobGate, GateAnswer } from '../../src/devplatform/pipeline/gateStore.js';

function gate(over: Partial<DevJobGate> = {}): DevJobGate {
  return {
    id: 'gate-1',
    jobId: 'job-1',
    planArtifactId: 'art-1',
    planSha256: 'abc',
    baseSha: 'deadbeef',
    questions: [{ id: 'q1', text: 'which?' }],
    principalKind: 'user',
    principalRef: 'user-1',
    status: 'waiting',
    answers: null,
    resolvedBy: null,
    resolvedAt: null,
    deadlineAt: null,
    createdAt: '2026-07-10T00:00:00Z',
    ...over,
  };
}

interface Fakes {
  gates: Map<string, DevJobGate>;
  resolveCalls: Array<{ gateId: string; approved: boolean; by: string }>;
  approved: Array<{ gate: DevJobGate; answers: GateAnswer[]; by: string }>;
  rejected: Array<{ gate: DevJobGate; note?: string; by: string }>;
  roles: Map<string, string[]>;
}

async function harness(seed: DevJobGate[], roles: Record<string, string[]> = {}, stuck = false) {
  const state: Fakes = {
    gates: new Map(seed.map((g) => [g.id, g])),
    resolveCalls: [],
    approved: [],
    rejected: [],
    roles: new Map(Object.entries(roles)),
  };
  const deps: DevPlatformGatesDeps = {
    gates: {
      listWaiting: async () => [...state.gates.values()].filter((g) => g.status === 'waiting'),
      get: async (id: string) => state.gates.get(id) ?? null,
      resolve: async (id, approved, by, answers) => {
        const g = state.gates.get(id);
        if (!g || g.status !== 'waiting') return null; // CAS
        state.resolveCalls.push({ gateId: id, approved, by });
        const next: DevJobGate = { ...g, status: approved ? 'resolved' : 'rejected', resolvedBy: by, answers: answers ?? null };
        state.gates.set(id, next);
        return next;
      },
    } as unknown as DevPlatformGatesDeps['gates'],
    resolveRoleHolders: async (key: string) => state.roles.get(key) ?? [],
    onApproved: async (g, answers, by) => void state.approved.push({ gate: g, answers, by }),
    onRejected: async (g, note, by) => void state.rejected.push({ gate: g, note, by }),
    isJobStuckAtGate: async () => stuck,
  };

  // A fake session: the x-test-sub header becomes req.session.sub.
  const inject: RequestHandler = (req, _res, next) => {
    const sub = req.header('x-test-sub');
    if (sub) (req as unknown as { session: { sub: string } }).session = { sub };
    next();
  };
  const app = express();
  app.use(inject);
  app.use('/api/v1/admin/dev-platform', createDevPlatformGatesRouter(deps));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/admin/dev-platform`;
  return {
    base,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function as(sub: string): Record<string, string> {
  return { 'x-test-sub': sub, 'content-type': 'application/json' };
}

describe('devPlatformGates — GET /gates', () => {
  it('lists waiting gates with their live holder set', async () => {
    const h = await harness([gate({ id: 'g1', principalKind: 'role', principalRef: 'approvers' })], {
      approvers: ['Alice', 'BOB'],
    });
    after(() => h.close());
    const res = await fetch(`${h.base}/gates?status=waiting`, { headers: as('user-1') });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { gates: Array<{ id: string; resolvedHolders: string[] }> };
    assert.equal(body.gates.length, 1);
    assert.deepEqual(body.gates[0]!.resolvedHolders.sort(), ['alice', 'bob'], 'roles resolved + canonicalized');
  });

  it('401s without a session', async () => {
    const h = await harness([gate()]);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates`);
    assert.equal(res.status, 401);
  });
});

describe('devPlatformGates — POST /gates/:id/resolve', () => {
  it('a user-principal holder can approve, and the job is requeued', async () => {
    const h = await harness([gate({ principalKind: 'user', principalRef: 'user-1' })]);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST',
      headers: as('user-1'),
      body: JSON.stringify({ approved: true, answers: [{ questionId: 'q1', text: 'yes' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(h.state.approved.length, 1);
    assert.deepEqual(h.state.approved[0]!.answers, [{ questionId: 'q1', text: 'yes' }]);
    assert.equal(h.state.rejected.length, 0);
  });

  it('a NON-holder gets 403 and the gate is untouched', async () => {
    const h = await harness([gate({ principalKind: 'user', principalRef: 'user-1' })]);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST',
      headers: as('someone-else'),
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { code: string }).code, 'devplatform.gate_not_holder');
    assert.equal(h.state.resolveCalls.length, 0, 'a non-holder never resolves');
  });

  it('resolves live against a moved role baton', async () => {
    const h = await harness([gate({ principalKind: 'role', principalRef: 'approvers' })], { approvers: ['carol'] });
    after(() => h.close());
    // carol currently holds the role → allowed.
    const ok = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST',
      headers: as('carol'),
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(ok.status, 200);
  });

  it('a second concurrent resolve gets 409 (CAS)', async () => {
    const h = await harness([gate({ principalKind: 'user', principalRef: 'user-1' })]);
    after(() => h.close());
    const first = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST', headers: as('user-1'), body: JSON.stringify({ approved: true }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST', headers: as('user-1'), body: JSON.stringify({ approved: false }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { code: string }).code, 'devplatform.gate_not_pending');
  });

  it('rejection records the note and cancels (no approval side effect)', async () => {
    const h = await harness([gate({ principalKind: 'user', principalRef: 'user-1' })]);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST', headers: as('user-1'), body: JSON.stringify({ approved: false, note: 'wrong approach' }),
    });
    assert.equal(res.status, 200);
    assert.equal(h.state.rejected.length, 1);
    assert.equal(h.state.rejected[0]!.note, 'wrong approach');
    assert.equal(h.state.approved.length, 0);
  });

  it('404s for an unknown gate', async () => {
    const h = await harness([]);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/nope/resolve`, {
      method: 'POST', headers: as('user-1'), body: JSON.stringify({ approved: true }),
    });
    assert.equal(res.status, 404);
  });

  it('self-heals a crash window: gate resolved but job still parked → re-drive, 200', async () => {
    // Simulate the winner having flipped the gate (status resolved, answers stored)
    // but crashed before the job transition ran. A retry must re-drive the side
    // effect from the gate's stored state, not 409 the holder into a stuck job.
    const alreadyResolved = gate({
      status: 'resolved',
      resolvedBy: 'user-1',
      answers: [{ questionId: 'q1', text: 'the winning answer' }],
    });
    const h = await harness([alreadyResolved], {}, /* stuck */ true);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST',
      headers: as('user-1'),
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { recovered?: boolean }).recovered, true);
    assert.equal(h.state.approved.length, 1, 'the stranded transition was re-driven');
    assert.deepEqual(h.state.approved[0]!.answers, [{ questionId: 'q1', text: 'the winning answer' }],
      'from the gate’s stored answers, not the retry’s empty body');
  });

  it('does NOT re-drive when the job already moved on (normal concurrent) → 409', async () => {
    const alreadyResolved = gate({ status: 'resolved', resolvedBy: 'other' });
    const h = await harness([alreadyResolved], {}, /* stuck */ false);
    after(() => h.close());
    const res = await fetch(`${h.base}/gates/gate-1/resolve`, {
      method: 'POST', headers: as('user-1'), body: JSON.stringify({ approved: true }),
    });
    assert.equal(res.status, 409);
    assert.equal(h.state.approved.length, 0, 'no double transition');
  });
});