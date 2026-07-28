import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorWebhookEndpointStore } from '../src/conductor/webhookEndpointStore.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

// Issue #437 review finding: ConductorWebhookEndpointStore.claim()'s dedupe +
// per-endpoint rate-limit SQL (pg_advisory_xact_lock + dedupe-before-count ordering)
// was only ever exercised through a hand-rolled in-memory fake pool
// (conductorWebhookEndpointStore.test.ts). This runs the SAME class against a real
// Postgres, proving the advisory-lock serialization actually holds under genuine
// concurrent connections — a hand-rolled fake pool cannot fake a real lock wait.

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
});
