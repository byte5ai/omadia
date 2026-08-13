import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorWebhookSubscriptionStore } from '../src/conductor/webhookSubscriptionStore.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import { ConductorRunStore } from '../src/conductor/runStore.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

// Issue #437 review finding: ConductorWebhookSubscriptionStore's transactional SQL
// (claimDue's FOR UPDATE SKIP LOCKED, claimOne, the listMissingRunDeliveries
// reconciliation JOIN against conductor_runs, recordFailure/recordSuccess) was only
// ever exercised through a hand-rolled in-memory fake (conductorWebhookDispatcher.test.ts).
// This runs the SAME class against a real Postgres.

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conductorWebhookSubscriptionStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MARK = 'webhooksubscriptionstore-pg-test';

/** `runConductorMigrations`'s `CREATE TABLE IF NOT EXISTS` is only idempotent once
 *  applied — the FIRST time two test files race it concurrently against a fresh
 *  database, both transactions can pass the not-yet-committed existence check and
 *  one loses with a 23505 (see conductorWebhookEndpointStore.pg.test.ts, which runs
 *  the same migrator). Retrying is safe: the loser's failed transaction rolled back
 *  cleanly, and the winner (or a subsequent retry) records the migration once. */
async function migrateWithRetry(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runConductorMigrations(pool);
      return;
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code !== '23505' || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

describe('ConductorWebhookSubscriptionStore (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConductorWebhookSubscriptionStore;
  let workflowStore: ConductorWorkflowStore;
  let runStore: ConductorRunStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await migrateWithRetry(pool);
    store = new ConductorWebhookSubscriptionStore(pool, new InMemorySecretVault());
    workflowStore = new ConductorWorkflowStore(pool);
    runStore = new ConductorRunStore(pool);
  });

  after(async () => {
    // conductor_runs has no ON DELETE CASCADE from conductor_workflow_versions (only
    // conductor_workflows → conductor_workflow_versions cascades) — delete the runs
    // first or the workflow delete below hits a foreign-key violation.
    await pool.query(
      `DELETE FROM conductor_runs WHERE workflow_version_id IN (
         SELECT v.id FROM conductor_workflow_versions v
           JOIN conductor_workflows w ON w.id = v.workflow_id
          WHERE w.slug LIKE $1
       )`,
      [`${MARK}%`],
    );
    await pool.query(`DELETE FROM conductor_workflows WHERE slug LIKE $1`, [`${MARK}%`]);
    // conductor_webhook_deliveries cascades from conductor_webhook_subscriptions.
    await pool.query(`DELETE FROM conductor_webhook_subscriptions WHERE created_by = $1`, [MARK]);
    await pool.end();
  });

  async function newSubscription(event = 'run.completed'): Promise<string> {
    const { subscription } = await store.create({ url: 'https://example.com/hook', event, createdBy: MARK });
    return subscription.id;
  }

  /** Creates a real workflow + published version + run driven all the way to a
   *  terminal status — the exact row shape `listMissingRunDeliveries` JOINs against. */
  async function terminalRun(status: 'completed' | 'failed', opts?: { isDryRun?: boolean }): Promise<string> {
    const slug = `${MARK}-${randomUUID().slice(0, 8)}`;
    const graph = { entryStepId: 's1', steps: [{ id: 's1', kind: 'action', actionId: 'noop' }], transitions: [] };
    const { version } = await workflowStore.createOrPublish({ slug, name: slug, graph: graph as never, enable: true });
    const claimedBy = randomUUID();
    const run = await runStore.create({
      workflowVersionId: version.id,
      entryStepId: 's1',
      context: {},
      triggerKind: 'manual',
      isDryRun: opts?.isDryRun ?? false,
      claimedBy,
    });
    await runStore.recordStepAndAdvance({
      runId: run.id,
      seq: 0,
      stepId: 's1',
      actor: null,
      postconditionOutcome: 'ok',
      transitionTaken: null,
      nextStepId: null,
      context: {},
      status,
      claimedBy,
    });
    return run.id;
  }

  it('create/list/get round-trip metadata (secret never lands in a returned row)', async () => {
    const { subscription, secret } = await store.create({ url: 'https://example.com/hook', event: 'run.completed', createdBy: MARK });
    assert.match(secret, /^[0-9a-f]{64}$/);
    const fetched = await store.get(subscription.id);
    assert.equal(fetched?.url, 'https://example.com/hook');
    assert.ok(!JSON.stringify(fetched).includes(secret));
    assert.equal(await store.getSecret(subscription.id), secret);
  });

  describe('claimDue (FOR UPDATE SKIP LOCKED)', () => {
    it('claims exactly once per delivery under concurrent callers — no double-claim', async () => {
      const subscriptionId = await newSubscription();
      const N = 6;
      for (let i = 0; i < N; i += 1) {
        await store.createDelivery({ subscriptionId, event: 'run.completed', payload: { i } });
      }
      // Two "workers" racing the same batch concurrently — SKIP LOCKED must partition
      // the due rows between them with zero overlap.
      const [batchA, batchB] = await Promise.all([store.claimDue(10), store.claimDue(10)]);
      const ids = [...batchA, ...batchB].map((d) => d.id);
      assert.equal(ids.length, N, `expected ${String(N)} total claimed across both workers, got ${String(ids.length)}`);
      assert.equal(new Set(ids).size, N, 'a delivery was claimed by both workers — SKIP LOCKED did not exclude it');
    });

    it('pushes next_attempt_at forward on claim so an immediate re-poll does not reclaim it', async () => {
      const subscriptionId = await newSubscription();
      await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      const first = await store.claimDue(10);
      assert.equal(first.length, 1);
      const second = await store.claimDue(10);
      assert.equal(second.length, 0, 'the row was pushed 5 minutes out and must not be immediately due again');
    });
  });

  describe('claimOne', () => {
    it('claims a due row exactly once; a second claimOne on the same id returns null', async () => {
      const subscriptionId = await newSubscription();
      const delivery = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });

      const first = await store.claimOne(delivery.id);
      assert.equal(first?.id, delivery.id);
      const second = await store.claimOne(delivery.id);
      assert.equal(second, null, 'already claimed — the inline path and a concurrent retry tick must not both win');
    });

    it('returns null for an unknown delivery id', async () => {
      assert.equal(await store.claimOne(randomUUID()), null);
    });

    it('closes the race: concurrent claimOne + claimDue on the same fresh row — exactly one path wins', async () => {
      const subscriptionId = await newSubscription();
      const delivery = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });

      const [viaClaimOne, viaClaimDue] = await Promise.all([store.claimOne(delivery.id), store.claimDue(10)]);
      const wonInline = viaClaimOne !== null;
      const wonBatch = viaClaimDue.some((d) => d.id === delivery.id);
      assert.notEqual(wonInline, wonBatch, 'exactly one of the two concurrent paths must have claimed the row, never both, never neither');
    });
  });

  // NB: every assertion below scopes by the EXACT (runId, subscriptionId) pair, not
  // bare runId — subscriptions created by earlier `it()`s in this describe block are
  // never cleaned up mid-suite (only in the top-level `after()`), so a bare "is this
  // runId present anywhere" check would false-positive against an unrelated
  // subscription created by a sibling test.
  describe('listMissingRunDeliveries (reconciliation JOIN)', () => {
    it('finds a terminal, non-dry-run run with an enabled matching subscription and no delivery row yet', async () => {
      const subscriptionId = await newSubscription('run.completed');
      const runId = await terminalRun('completed');
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(
        missing.some((m) => m.runId === runId && m.subscriptionId === subscriptionId && m.status === 'completed'),
        JSON.stringify(missing),
      );
    });

    it('stops reporting a run once its delivery row is created', async () => {
      const subscriptionId = await newSubscription('run.completed');
      const runId = await terminalRun('completed');
      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      const pair = (m: { runId: string; subscriptionId: string }): boolean => m.runId === runId && m.subscriptionId === subscriptionId;
      assert.ok((await store.listMissingRunDeliveries(sinceIso)).some(pair));

      await store.createDelivery({ subscriptionId, event: 'run.completed', payload: { runId } });

      assert.ok(!(await store.listMissingRunDeliveries(sinceIso)).some(pair), 'the (run, subscription) pair must no longer be "missing" once a delivery row exists for it');
    });

    it('matches the run status to the subscription event (run.failed only matches a failed run)', async () => {
      const subscriptionId = await newSubscription('run.failed');
      const completedRunId = await terminalRun('completed');
      const failedRunId = await terminalRun('failed');
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(
        missing.some((m) => m.runId === failedRunId && m.subscriptionId === subscriptionId),
        'the failed run should match the run.failed subscription',
      );
      assert.ok(
        !missing.some((m) => m.runId === completedRunId && m.subscriptionId === subscriptionId),
        'the completed run must not match THIS run.failed subscription',
      );
    });

    it('ignores a disabled subscription and a dry-run', async () => {
      const { subscription } = await store.create({ url: 'https://example.com/hook', event: 'run.completed', createdBy: MARK });
      await store.setEnabled(subscription.id, false);
      const dryRunId = await terminalRun('completed', { isDryRun: true });
      const disabledSubRunId = await terminalRun('completed');
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(!missing.some((m) => m.runId === dryRunId), 'a dry run must never be reconciled into a real delivery, against ANY subscription');
      assert.ok(
        !missing.some((m) => m.runId === disabledSubRunId && m.subscriptionId === subscription.id),
        'a disabled subscription must not generate a reconciliation entry for its own event',
      );
    });

    it('excludes runs that ended before the sinceIso window', async () => {
      await newSubscription('run.completed');
      const runId = await terminalRun('completed');
      const futureSinceIso = new Date(Date.now() + 60_000).toISOString(); // window starts in the future
      const missing = await store.listMissingRunDeliveries(futureSinceIso);
      assert.ok(!missing.some((m) => m.runId === runId), 'a run that ended before the window start must be excluded');
    });

    // Review finding: reconciliation must also be bounded by the subscription's OWN
    // lifecycle (`enabled_since`), not just the caller's sinceIso lookback — otherwise
    // creating a new subscription, or re-enabling a disabled one, backfills every
    // matching run from the whole lookback window, including ones that ended before
    // the subscription ever existed or while it was disabled.
    it('excludes a run that ended BEFORE the subscription was created, even though it is inside the sinceIso window', async () => {
      const runId = await terminalRun('completed');
      const subscriptionId = await newSubscription('run.completed'); // created strictly AFTER the run ended
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(
        !missing.some((m) => m.runId === runId && m.subscriptionId === subscriptionId),
        'a run that ended before the subscription existed must never be backfilled',
      );
    });

    it('excludes a run that ended while the subscription was disabled, even after it is later re-enabled', async () => {
      const subscriptionId = await newSubscription('run.completed');
      await store.setEnabled(subscriptionId, false);
      const runId = await terminalRun('completed'); // ends during the disabled window
      await store.setEnabled(subscriptionId, true); // re-enabled AFTER the run already ended
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(
        !missing.some((m) => m.runId === runId && m.subscriptionId === subscriptionId),
        'a run that ended during the disabled window must not be resurrected just because the subscription was later re-enabled',
      );
    });

    it('includes a run that ends AFTER the subscription is re-enabled', async () => {
      const subscriptionId = await newSubscription('run.completed');
      await store.setEnabled(subscriptionId, false);
      await store.setEnabled(subscriptionId, true);
      const runId = await terminalRun('completed'); // ends after the re-enable transition
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const missing = await store.listMissingRunDeliveries(sinceIso);
      assert.ok(missing.some((m) => m.runId === runId && m.subscriptionId === subscriptionId), 'a run ending after re-enable must still be reconciled normally');
    });
  });

  // Review finding: without a uniqueness constraint on (subscription_id, run_id),
  // reconciliation racing the live terminal-run hook (or two concurrent replicas both
  // reconciling) could each pass an unlocked NOT EXISTS check and both create a
  // delivery for the same run — sending the same webhook twice. createDelivery must
  // be conflict-safe: at most one delivery per (subscription, run) pair, ever.
  describe('createDelivery uniqueness on (subscription, run)', () => {
    it('a second createDelivery for the same (subscription, run) pair returns the EXISTING row, not a new one', async () => {
      const subscriptionId = await newSubscription();
      const runId = randomUUID();

      const first = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: { runId } });
      const second = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: { runId } });

      assert.equal(second.id, first.id, 'a duplicate create for the same run+subscription must return the row that already won, not create a second one');
      const rows = await store.listForSubscription(subscriptionId, 10);
      assert.equal(rows.filter((r) => r.payload['runId'] === runId).length, 1);
    });

    it('concurrent createDelivery calls for the same (subscription, run) pair converge on exactly one row', async () => {
      const subscriptionId = await newSubscription();
      const runId = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.createDelivery({ subscriptionId, event: 'run.completed', payload: { runId } })),
      );

      assert.equal(new Set(results.map((d) => d.id)).size, 1, 'concurrent races for the same run+subscription must never create more than one delivery row');
    });

    it('deliveries with no runId in the payload are never deduped against each other', async () => {
      const subscriptionId = await newSubscription();
      const a = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      const b = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      assert.notEqual(a.id, b.id, 'a delivery with no runId must never collide with another no-runId delivery for the same subscription');
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('recordSuccess marks delivered, stamps deliveredAt, clears lastError', async () => {
      const subscriptionId = await newSubscription();
      const delivery = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      await store.recordFailure(delivery.id, 'first attempt failed', new Date(Date.now() + 1000));
      await store.recordSuccess(delivery.id);

      const [row] = await store.listForSubscription(subscriptionId, 1);
      assert.equal(row?.status, 'delivered');
      assert.equal(row?.lastError, null);
      assert.ok(row?.deliveredAt);
      assert.equal(row?.attempts, 2);
    });

    it('recordFailure with a nextAttemptAt stays pending (retryable)', async () => {
      const subscriptionId = await newSubscription();
      const delivery = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      const nextAttempt = new Date(Date.now() + 60_000);
      await store.recordFailure(delivery.id, 'boom', nextAttempt);

      const [row] = await store.listForSubscription(subscriptionId, 1);
      assert.equal(row?.status, 'pending');
      assert.equal(row?.attempts, 1);
      assert.equal(row?.lastError, 'boom');
    });

    it('recordFailure with nextAttemptAt=null marks the delivery exhausted', async () => {
      const subscriptionId = await newSubscription();
      const delivery = await store.createDelivery({ subscriptionId, event: 'run.completed', payload: {} });
      await store.recordFailure(delivery.id, 'final failure', null);

      const [row] = await store.listForSubscription(subscriptionId, 1);
      assert.equal(row?.status, 'exhausted');
    });
  });
});
