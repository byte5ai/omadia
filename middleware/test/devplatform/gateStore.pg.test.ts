import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobGateStore } from '../../src/devplatform/pipeline/gateStore.js';
import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  await probe.end();
} catch {
  pgAvailable = false;
}

const MARK = 'gatestore-test';

describe('devplatform/DevJobGateStore (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let jobStore: DevJobStore;
  let repoId = '';

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await runMultiOrchestratorMigrations(pool);
    jobStore = new DevJobStore(pool);
    const repoStore = new DevRepoStore(pool);
    const repo = await repoStore.createRepo({
      owner: 'byte5ai',
      name: `gate-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://github.com/byte5ai/omadia.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      runsTests: true,
      createdBy: MARK,
    });
    repoId = repo.id;
  });

  after(async () => {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
    await pool.end();
  });

  async function newJob(): Promise<string> {
    const job = await jobStore.createJob({
      repoId,
      kind: 'fix_issue',
      brief: 'gate test',
      source: 'admin',
      sourceRef: null,
      backend: 'docker',
      createdBy: MARK,
      runnerTokenHash: '',
    });
    return job.id;
  }

  it('opens a gate and is idempotent — a second open returns the SAME gate', async () => {
    const jobId = await newJob();
    const store = new DevJobGateStore(pool);
    const g1 = await store.open({
      jobId,
      questions: [{ id: 'q1', text: 'Which approach?' }],
      principalKind: 'user',
      principalRef: 'user-1',
      planSha256: 'abc',
      baseSha: 'deadbeef',
    });
    const g2 = await store.open({
      jobId,
      questions: [{ id: 'q2', text: 'different' }],
      principalKind: 'user',
      principalRef: 'user-1',
    });
    assert.equal(g1.id, g2.id, 'the partial unique index prevents a duplicate open');
    assert.equal(g2.questions[0]!.id, 'q1', 'the original gate wins, not the retry');
    assert.equal(g1.planSha256, 'abc');
  });

  it('resolves via compare-and-swap: the second concurrent resolver gets null (409)', async () => {
    const jobId = await newJob();
    const store = new DevJobGateStore(pool);
    const gate = await store.open({ jobId, questions: [], principalKind: 'user', principalRef: 'user-1' });

    const first = await store.resolve(gate.id, true, 'user-1', [{ questionId: 'q1', text: 'yes' }]);
    assert.equal(first?.status, 'resolved');
    assert.equal(first?.resolvedBy, 'user-1');
    assert.deepEqual(first?.answers, [{ questionId: 'q1', text: 'yes' }]);

    const second = await store.resolve(gate.id, false, 'user-2');
    assert.equal(second, null, 'a resolved gate cannot be re-resolved — the CAS fails');
    assert.equal((await store.get(gate.id))?.status, 'resolved', 'and the state is unchanged');
  });

  it('a rejected gate records the rejecter', async () => {
    const jobId = await newJob();
    const store = new DevJobGateStore(pool);
    const gate = await store.open({ jobId, questions: [], principalKind: 'user', principalRef: 'user-1' });
    const r = await store.resolve(gate.id, false, 'user-9');
    assert.equal(r?.status, 'rejected');
    assert.equal(r?.resolvedBy, 'user-9');
  });

  it('a new gate can open after the previous one is resolved (index only blocks WAITING)', async () => {
    const jobId = await newJob();
    const store = new DevJobGateStore(pool);
    const g1 = await store.open({ jobId, questions: [], principalKind: 'user', principalRef: 'u' });
    await store.resolve(g1.id, true, 'u');
    const g2 = await store.open({ jobId, questions: [], principalKind: 'user', principalRef: 'u' });
    assert.notEqual(g1.id, g2.id, 'a second gate opens once the first is no longer waiting');
  });

  it('the deadline worker expires an overdue gate, and only once', async () => {
    const jobId = await newJob();
    let t = 1_000_000;
    const store = new DevJobGateStore(pool, () => t);
    const gate = await store.open({ jobId, questions: [], principalKind: 'user', principalRef: 'u', deadlineIso: 'PT1H' });

    assert.equal((await store.listDue()).length, 0, 'not due yet');
    t += 2 * 60 * 60 * 1000; // advance 2h past the 1h deadline
    const due = await store.listDue();
    assert.ok(due.some((g) => g.id === gate.id), 'now overdue');

    const expired = await store.expire(gate.id);
    assert.equal(expired?.status, 'expired');
    const again = await store.expire(gate.id);
    assert.equal(again, null, 'an already-expired gate cannot be expired twice');
  });

  it('cancelForJob flips a waiting gate to cancelled', async () => {
    const jobId = await newJob();
    const store = new DevJobGateStore(pool);
    const gate = await store.open({ jobId, questions: [], principalKind: 'role', principalRef: 'approvers' });
    assert.equal(await store.cancelForJob(jobId), true);
    assert.equal((await store.get(gate.id))?.status, 'cancelled');
    assert.equal(await store.cancelForJob(jobId), false, 'nothing left to cancel');
  });
});
