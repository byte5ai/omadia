/**
 * Spec 2042 §5.10, criterion 37 — the outbox of owed `system` notices on a
 * real Postgres (migration 0109): written once per agent, kind and
 * conversation; sent by the worker that holds the lease; a lost lease never
 * overwrites the outcome of the worker that took it over; a channel that is
 * not up yet defers without spending an attempt; a send that never returns
 * ends `failed`.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { createSystemNoticeOutbox, type NoticeSendOutcome } from '../src/platform/systemNoticeOutbox.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'systemNoticeOutbox',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `system_notice_outbox_${String(process.pid)}`;
const AGENT = '5f0c1a2b-0000-4000-8000-0000000000aa';
const NOTICE = {
  kind: 'archetype_plugin_removed' as const,
  channelType: 'teams',
  channelKey: '19:offsite@thread.v2',
  agentId: AGENT,
  agentName: 'Mara',
  agentSlug: 'mara',
};

describe('system notice outbox (pg, 0109)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const logs: string[] = [];

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    logs.length = 0;
    await pool.query('DELETE FROM system_notice_outbox');
  });

  const outbox = (send: () => Promise<NoticeSendOutcome>, opts: { leaseMs?: number; locale?: string } = {}) =>
    createSystemNoticeOutbox({
      pool: () => pool,
      send: async () => send(),
      locale: () => opts.locale,
      ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
      maxAttempts: 3,
      log: (m) => logs.push(m),
    });
  const rows = async () =>
    (await pool.query<{ state: string; attempts: number; text: string }>('SELECT state, attempts, text FROM system_notice_outbox')).rows;
  // A drain whose send has not returned cannot be awaited, and it claims when
  // the pool gets to its statement, which on a loaded runner is well after a
  // fixed sleep. Steps that depend on a claim or on a lease running out wait
  // for the row itself, never for the wall clock.
  const until = async (sql: string, what: string): Promise<void> => {
    for (let i = 0; i < 500; i += 1) {
      if ((await pool.query<{ ok: boolean | null }>(sql)).rows[0]?.ok === true) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const claimed = (attempts: number) =>
    until(
      `SELECT bool_and(state = 'sending' AND attempts = ${String(attempts)}) AS ok FROM system_notice_outbox`,
      `a claim with ${String(attempts)} attempt(s) spent`,
    );
  const leaseRanOut = () =>
    until('SELECT bool_and(lease_until < now()) AS ok FROM system_notice_outbox', 'the lease to run out');

  it('two machines ending the same agent write one notice; it is localized and sent once', async () => {
    const sent: string[] = [];
    const a = outbox(async () => (sent.push('a'), { delivered: true }), { locale: 'en' });
    const b = outbox(async () => (sent.push('b'), { delivered: true }), { locale: 'en' });
    await Promise.all([a.emit(NOTICE), b.emit(NOTICE)]);
    await Promise.all([a.drain(), b.drain()]);
    assert.equal(sent.length, 1);
    const [row] = await rows();
    assert.equal(row?.state, 'sent');
    assert.match(row?.text ?? '', /^Mara is no longer available: the plugin for Mara's role was removed/);
  });

  it('a channel that is not up yet defers the notice without spending an attempt', async () => {
    const box = outbox(async () => ({ delivered: false, reason: 'no conversation sender', deferred: true }));
    await box.emit(NOTICE);
    await box.drain();
    assert.deepEqual((await rows()).map((r) => [r.state, r.attempts]), [['pending', 0]]);
  });

  it('a worker whose lease ran out cannot overwrite the outcome of the one that took over', async () => {
    let release: (o: NoticeSendOutcome) => void = () => undefined;
    const slow = outbox(() => new Promise<NoticeSendOutcome>((r) => (release = r)), { leaseMs: 50 });
    await slow.emit(NOTICE);
    const slowDrain = slow.drain();
    await claimed(0);
    await leaseRanOut();
    const fast = outbox(async () => ({ delivered: true }));
    assert.equal(await fast.drain(), 1, 'the expired lease is taken over');
    release({ delivered: false, reason: 'bot framework 502' });
    await slowDrain;
    assert.deepEqual((await rows()).map((r) => [r.state, r.attempts]), [['sent', 1]], 'the late failure changed nothing');
  });

  it('a send that never returns spends its attempts and ends failed', async () => {
    const hanging = () => outbox(() => new Promise<NoticeSendOutcome>(() => undefined), { leaseMs: 20 });
    await hanging().emit(NOTICE); // emit starts the first drain; its send never returns
    await claimed(0);
    for (const attempts of [1, 2]) {
      await leaseRanOut();
      void hanging().drain(); // takes the row over, spending the attempt that had no outcome
      await claimed(attempts);
    }
    await leaseRanOut();
    // The last allowed lease ran out: the next drain ends the row instead of sending it.
    await outbox(async () => ({ delivered: true })).drain();
    assert.deepEqual((await rows()).map((r) => [r.state, r.attempts]), [['failed', 3]]);
  });
});
