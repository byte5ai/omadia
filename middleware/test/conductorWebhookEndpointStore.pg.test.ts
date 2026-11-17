import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorWebhookEndpointStore } from '../src/conductor/webhookEndpointStore.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

// Issue #437 review finding: ConductorWebhookEndpointStore.claim()'s dedupe +
// per-endpoint rate-limit SQL (pg_advisory_xact_lock + dedupe-before-count ordering)
// was only ever exercised through a hand-rolled in-memory fake pool
// (conductorWebhookEndpointStore.test.ts). This runs the SAME class against a real
// Postgres, proving the advisory-lock serialization actually holds under genuine
// concurrent connections — a hand-rolled fake pool cannot fake a real lock wait.

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conductorWebhookEndpointStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MARK = 'webhookendpointstore-pg-test';

/** `runConductorMigrations`'s `CREATE TABLE IF NOT EXISTS` is only idempotent once
 *  applied — the FIRST time two test files race it concurrently against a fresh
 *  database, both transactions can pass the not-yet-committed existence check and
 *  one loses with a 23505 (see conductorWebhookSubscriptionStore.pg.test.ts, which
 *  runs the same migrator). Retrying is safe: the loser's failed transaction rolled
 *  back cleanly, and the winner (or a subsequent retry) records the migration once. */
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

describe('ConductorWebhookEndpointStore (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConductorWebhookEndpointStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await migrateWithRetry(pool);
    store = new ConductorWebhookEndpointStore(pool, new InMemorySecretVault());
  });

  after(async () => {
    await pool.query(`DELETE FROM conductor_webhook_endpoints WHERE created_by = $1`, [MARK]);
    await pool.end();
  });

  async function newEndpoint(eventId = 'orders.created'): Promise<string> {
    const { endpoint } = await store.create({ eventId, createdBy: MARK });
    return endpoint.endpointId;
  }

  it('claim() dedupes a redelivered id against the real (endpoint_id, delivery_id) PK', async () => {
    const endpointId = await newEndpoint();
    const cap = { limit: 1_000, windowMs: 60_000 };

    const first = await store.claim('delivery-1', endpointId, cap);
    const second = await store.claim('delivery-1', endpointId, cap);

    assert.equal(first, 'claimed');
    assert.equal(second, 'duplicate');
  });

  it('claim() scopes dedupe per endpoint — two endpoints can each claim the same delivery id (composite PK)', async () => {
    const epA = await newEndpoint();
    const epB = await newEndpoint();
    const cap = { limit: 1_000, windowMs: 60_000 };

    const a = await store.claim('shared-id', epA, cap);
    const b = await store.claim('shared-id', epB, cap);

    assert.equal(a, 'claimed');
    assert.equal(b, 'claimed');
  });

  it('claim() rate-limits an endpoint once its rolling-window cap is reached, and a rate-limited call inserts no row', async () => {
    const endpointId = await newEndpoint();
    const cap = { limit: 2, windowMs: 60_000 };

    assert.equal(await store.claim('d-1', endpointId, cap), 'claimed');
    assert.equal(await store.claim('d-2', endpointId, cap), 'claimed');
    assert.equal(await store.claim('d-3', endpointId, cap), 'rate_limited');

    const deliveries = await store.listDeliveries(endpointId, 10);
    assert.equal(deliveries.length, 2, 'the rate-limited call must not have inserted a third row');
  });

  it("dedupe wins over rate-limiting: a redelivery of an already-claimed id is 'duplicate' even at a full cap", async () => {
    const endpointId = await newEndpoint();
    const cap = { limit: 1, windowMs: 60_000 };

    assert.equal(await store.claim('d-1', endpointId, cap), 'claimed'); // fills the cap
    // a redelivery of the SAME id must be reported as a dupe, not rate_limited,
    // even though the endpoint is now at its cap.
    assert.equal(await store.claim('d-1', endpointId, cap), 'duplicate');
  });

  it('the pg_advisory_xact_lock serializes concurrent claims — N concurrent callers against a cap of N each get exactly one slot, no double-claim', async () => {
    const endpointId = await newEndpoint();
    const N = 8;
    const cap = { limit: N, windowMs: 60_000 };
    // Every caller uses a UNIQUE delivery id — this isolates the rate-limit counting
    // path (the advisory lock serializing count→insert) from the dedupe path, so a
    // false 'claimed' would only be possible if two concurrent transactions both saw
    // the pre-lock count and both inserted, i.e. exactly the TOCTOU the lock closes.
    const ids = Array.from({ length: N + 4 }, (_, i) => `concurrent-${String(i)}-${randomUUID()}`);
    const results = await Promise.all(ids.map((id) => store.claim(id, endpointId, cap)));

    const claimed = results.filter((r) => r === 'claimed').length;
    const rateLimited = results.filter((r) => r === 'rate_limited').length;
    assert.equal(claimed, N, `expected exactly the cap (${String(N)}) to be claimed, got ${String(claimed)}`);
    assert.equal(rateLimited, ids.length - N);

    const deliveries = await store.listDeliveries(endpointId, 100);
    assert.equal(deliveries.length, N, 'no more rows than the cap were ever inserted, even under concurrency');
  });

  // Review finding: a delivery is claimed (row inserted, outcome='received') BEFORE
  // the caller runs emit(). If the caller crashes before it can call setOutcome(), a
  // retry with the SAME delivery id must eventually be allowed to re-attempt emit() —
  // not be told 'duplicate' forever, which would lose the event permanently.
  describe('claim() recovery from an abandoned in-flight claim', () => {
    it('a retry within the staleness window is still a duplicate (protects a genuinely concurrent redelivery)', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      assert.equal(await store.claim('d-crash', endpointId, cap), 'claimed');
      // No setOutcome() call — simulates a crash right after claim(), before finish().
      // Immediately retrying (well within the staleness window) must still see a
      // duplicate: this is what protects against a truly concurrent redelivery
      // double-processing the same event.
      assert.equal(await store.claim('d-crash', endpointId, cap), 'duplicate');
    });

    it('a retry after the staleness window re-claims an abandoned (still-received) row instead of reporting it as a duplicate', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      assert.equal(await store.claim('d-abandoned', endpointId, cap), 'claimed');
      // Simulate the staleness window having elapsed without a terminal outcome ever
      // being recorded (the crash scenario) by backdating received_at directly —
      // faster and more deterministic than actually waiting IN_FLIGHT_CLAIM_STALE_MS.
      await pool.query(
        `UPDATE conductor_webhook_inbound_deliveries
            SET received_at = now() - interval '31 seconds'
          WHERE endpoint_id = $1 AND delivery_id = $2`,
        [endpointId, 'd-abandoned'],
      );

      const retried = await store.claim('d-abandoned', endpointId, cap);
      assert.equal(retried, 'claimed', 'a stale, never-finished claim must be re-claimable, not a terminal duplicate');

      // Still exactly one row — re-claiming must not insert a second delivery row.
      const deliveries = await store.listDeliveries(endpointId, 10);
      assert.equal(deliveries.length, 1);
    });

    it('a row that DID reach a terminal outcome is always a duplicate, no matter how old', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      assert.equal(await store.claim('d-done', endpointId, cap), 'claimed');
      await store.setOutcome('d-done', endpointId, 'started');
      await pool.query(
        `UPDATE conductor_webhook_inbound_deliveries SET received_at = now() - interval '1 hour'
          WHERE endpoint_id = $1 AND delivery_id = $2`,
        [endpointId, 'd-done'],
      );

      assert.equal(await store.claim('d-done', endpointId, cap), 'duplicate', 'a delivery that actually completed must never be re-processed');
    });
  });

  // Issue #1701 — a request to a DISABLED endpoint is answered 200 {"outcome":"disabled"}
  // and still written to this ledger. The dedupe check used to look only at the key, so
  // the sender's honest redelivery after the endpoint was enabled again was answered
  // 'duplicate', no run started, and the event was lost silently. 'disabled' records an
  // attempt the endpoint REFUSED — emit() never ran — so it must not consume the id.
  describe('claim() after a delivery refused because the endpoint was disabled (#1701)', () => {
    it('re-claims the row, so the sender can redeliver the same id once the endpoint is enabled again', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      // Endpoint disabled: the route claims the id, then finalizes 'disabled'.
      assert.equal(await store.claim('d7', endpointId, cap), 'claimed');
      await store.setOutcome('d7', endpointId, 'disabled');

      // Endpoint enabled again, same delivery id redelivered.
      const retried = await store.claim('d7', endpointId, cap);

      assert.equal(retried, 'claimed', "a delivery refused as 'disabled' must not consume the delivery id");
      const deliveries = await store.listDeliveries(endpointId, 10);
      assert.equal(deliveries.length, 1, 're-claiming reuses the row rather than inserting a second one');
      // Documented consequence of the single-row ledger: the re-claim overwrites the
      // refusal, so 'disabled' survives only while nobody has redelivered the id.
      assert.equal(deliveries[0]?.outcome, 'received', 'the re-claimed row is in flight again');
    });

    it('needs no staleness window — a refusal is re-claimable immediately', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      assert.equal(await store.claim('d-fresh', endpointId, cap), 'claimed');
      await store.setOutcome('d-fresh', endpointId, 'disabled');
      // received_at is "now": an operator can re-enable the endpoint a second later,
      // so unlike the abandoned-in-flight case there is nothing to wait out.
      assert.equal(await store.claim('d-fresh', endpointId, cap), 'claimed');
    });

    it('a repeatedly-refused delivery id never inserts a second row', async () => {
      const endpointId = await newEndpoint();
      const cap = { limit: 1_000, windowMs: 60_000 };

      for (let i = 0; i < 3; i += 1) {
        assert.equal(await store.claim('d-loop', endpointId, cap), 'claimed');
        await store.setOutcome('d-loop', endpointId, 'disabled');
      }

      const deliveries = await store.listDeliveries(endpointId, 10);
      assert.equal(deliveries.length, 1);
      // The refusals an operator still needs to see — nobody redelivered this id, so
      // the ledger keeps showing that the endpoint turned the sender away.
      assert.equal(deliveries[0]?.outcome, 'disabled');
    });
  });

  it('claim() rate limit is scoped per endpoint under concurrency — a saturated endpoint never throttles another', async () => {
    const busy = await newEndpoint();
    const other = await newEndpoint();
    const cap = { limit: 1, windowMs: 60_000 };

    const [busyResults, otherResult] = await Promise.all([
      Promise.all(['b-1', 'b-2', 'b-3'].map((id) => store.claim(id, busy, cap))),
      store.claim('o-1', other, cap),
    ]);

    assert.equal(busyResults.filter((r) => r === 'claimed').length, 1);
    assert.equal(otherResult, 'claimed');
  });

  // ── #1707: secret rotation grace ────────────────────────────────────────────
  // Reported: `POST …/rotate-secret` took effect immediately — the old secret
  // answered 401 on the sender's very next request, with no overlap window in which
  // the sender could be reconfigured.
  describe('rotation grace (#1707)', () => {
    async function newEndpoint(): Promise<{ endpointId: string; secret: string }> {
      const { endpoint, secret } = await store.create({ eventId: 'orders.created', createdBy: MARK });
      return { endpointId: endpoint.endpointId, secret };
    }

    it('keeps the superseded secret valid until the grace deadline', async () => {
      const { endpointId, secret: first } = await newEndpoint();
      const second = await store.rotateSecret(endpointId, 60_000);
      assert.notEqual(second, first);

      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, second);
      assert.equal(secrets.previous, first);

      const row = await store.get(endpointId);
      assert.ok(row?.secretPreviousUntil instanceof Date);
      assert.ok((row?.secretPreviousUntil?.getTime() ?? 0) > Date.now());
    });

    it('a zero grace cuts over instantly — the answer to a leaked secret', async () => {
      const { endpointId, secret: first } = await newEndpoint();
      const second = await store.rotateSecret(endpointId, 0);
      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, second);
      assert.equal(secrets.previous, undefined);
      assert.notEqual(second, first);
      assert.equal((await store.get(endpointId))?.secretPreviousUntil, null);
    });

    it('a lapsed grace stops offering the old secret AND clears the deadline (one write, not one per request)', async () => {
      const { endpointId, secret: first } = await newEndpoint();
      await store.rotateSecret(endpointId, 60_000);
      // Backdate the deadline rather than sleeping: the anchor is the DB clock.
      await pool.query(
        `UPDATE conductor_webhook_endpoints SET secret_previous_until = now() - interval '1 second' WHERE endpoint_id = $1`,
        [endpointId],
      );
      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.previous, undefined);
      assert.notEqual(secrets.current, first);
      assert.equal((await store.get(endpointId))?.secretPreviousUntil, null);
      // And the vault key is gone, so nothing can resurrect it.
      const again = await store.getVerificationSecrets(endpointId);
      assert.equal(again.previous, undefined);
    });

    it('a second rotation inside the window supersedes the FIRST old secret (no chain of live secrets)', async () => {
      const { endpointId, secret: first } = await newEndpoint();
      const second = await store.rotateSecret(endpointId, 60_000);
      const third = await store.rotateSecret(endpointId, 60_000);
      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, third);
      assert.equal(secrets.previous, second);
      assert.notEqual(secrets.previous, first);
    });

    // Review finding (the race the lifecycle lock closes): `rotateSecret` writes the
    // new current secret, then the previous key, then stamps the deadline — across
    // TWO stores, so no transaction spans it. A verification arriving in between used
    // to see the EARLIER rotation's lapsed deadline, run its cleanup, and delete the
    // previous key this rotation had just written: the sender got 401s for a grace
    // window it had been promised. Both writers now hold the same advisory lock and
    // the cleanup re-checks `<= now()` inside it, so neither interleaving can lose
    // the key — which makes the assertion below hold whichever order wins.
    it('a verification racing a re-rotation never deletes the secret that rotation just preserved', async () => {
      const { endpointId } = await newEndpoint();
      // Leave a LAPSED grace behind — the state that armed the bug (a first rotation
      // leaves the deadline NULL, and the cleanup then matches no row).
      await store.rotateSecret(endpointId, 60_000);
      await pool.query(
        `UPDATE conductor_webhook_endpoints SET secret_previous_until = now() - interval '1 second' WHERE endpoint_id = $1`,
        [endpointId],
      );
      const supersededByRotation = await store.getSecret(endpointId);

      // The read path prunes; the rotation preserves. Run them together.
      const [, rotated] = await Promise.all([
        store.getVerificationSecrets(endpointId),
        store.rotateSecret(endpointId, 60_000),
      ]);

      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, rotated);
      assert.equal(
        secrets.previous,
        supersededByRotation,
        'the grace window must survive a concurrent prune — this is the regression',
      );
      const row = await store.get(endpointId);
      assert.ok((row?.secretPreviousUntil?.getTime() ?? 0) > Date.now());
    });

    it('concurrent rotations are serialized: the survivor supersedes the other, not the original', async () => {
      const { endpointId, secret: original } = await newEndpoint();
      const [a, b] = await Promise.all([store.rotateSecret(endpointId, 60_000), store.rotateSecret(endpointId, 60_000)]);
      const secrets = await store.getVerificationSecrets(endpointId);
      // Whichever rotation committed last owns `current`, and the previous slot holds
      // the OTHER rotation's secret — never the original both would have read without
      // the lock.
      assert.ok(secrets.current === a || secrets.current === b);
      assert.equal(secrets.previous, secrets.current === a ? b : a);
      assert.notEqual(secrets.previous, original);
    });

    // Review finding on the ORDER of the two writes: the current key used to be
    // swapped before the deadline was stamped, so a delivery arriving in that gap saw
    // `previous_live = false` against an already-new current key and 401'd the old
    // secret — the exact outage the grace exists to remove. Parking the superseded
    // secret and stamping its deadline first means every intermediate state still
    // accepts the old secret.
    it('leaves no instant in which the old secret is refused: both secrets verify right after rotating', async () => {
      const { endpointId, secret: original } = await newEndpoint();
      const rotated = await store.rotateSecret(endpointId, 60_000);
      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, rotated);
      assert.equal(secrets.previous, original, 'the secret the sender still holds must verify');
    });

    it('a zero-grace rotation kills the deadline before the swap, so no previous secret survives it', async () => {
      const { endpointId } = await newEndpoint();
      await store.rotateSecret(endpointId, 60_000); // a live grace to tear down
      const supersededTwice = await store.getSecret(endpointId);
      const rotated = await store.rotateSecret(endpointId, 0);

      const secrets = await store.getVerificationSecrets(endpointId);
      assert.equal(secrets.current, rotated);
      assert.equal(secrets.previous, undefined, 'a leak rotation must leave nothing else accepted');
      assert.notEqual(rotated, supersededTwice);
      assert.equal((await store.get(endpointId))?.secretPreviousUntil, null);
    });

    it('an unknown endpoint yields no secrets at all — the route must 401 it exactly like a wrong secret', async () => {
      assert.deepEqual(await store.getVerificationSecrets('does-not-exist'), {});
    });

    it('deleting the endpoint takes the grace secret with it', async () => {
      const { endpointId } = await newEndpoint();
      await store.rotateSecret(endpointId, 60_000);
      await store.delete(endpointId);
      assert.deepEqual(await store.getVerificationSecrets(endpointId), {});
    });
  });
});
