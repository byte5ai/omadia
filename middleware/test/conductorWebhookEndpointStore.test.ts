import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { ConductorWebhookEndpointStore, CONDUCTOR_VAULT_AGENT_ID } from '../src/conductor/webhookEndpointStore.js';
import type { SecretVault } from '../src/secrets/vault.js';

// Issue #437 — the metadata-in-Postgres / secret-in-Vault split (modeled on
// DevGithubAppStore): the secret is never written to a conductor_webhook_endpoints
// column, and the inbound delivery claim is a dedupe no-op on the second call.

interface IssuedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(): { pool: Pool; queries: IssuedQuery[]; deliveryClaims: Set<string> } {
  const queries: IssuedQuery[] = [];
  // Keyed `${endpointId}::${deliveryId}` — the composite (endpoint_id, delivery_id)
  // PK the real table enforces, so two endpoints can each claim their own id '1'.
  const deliveryClaims = new Set<string>();
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO conductor_webhook_endpoints')) {
      const [endpointId, eventId, description, createdBy] = params as [string, string, string | null, string];
      return {
        rows: [
          {
            endpoint_id: endpointId,
            event_id: eventId,
            description,
            enabled: true,
            created_by: createdBy,
            created_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK') || s.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM conductor_webhook_inbound_deliveries')) {
      const [endpointId, deliveryId] = params as [string, string];
      const exists = deliveryClaims.has(`${endpointId}::${deliveryId}`);
      return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (s.startsWith('SELECT COUNT(*)::text AS n FROM conductor_webhook_inbound_deliveries')) {
      const [endpointId] = params as [string];
      const prefix = `${endpointId}::`;
      const n = [...deliveryClaims].filter((k) => k.startsWith(prefix)).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO conductor_webhook_inbound_deliveries')) {
      const [deliveryId, endpointId] = params as [string, string];
      const key = `${endpointId}::${deliveryId}`;
      if (deliveryClaims.has(key)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      deliveryClaims.add(key);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, queries, deliveryClaims };
}

const NO_RATE_LIMIT = { limit: 1_000_000, windowMs: 60_000 };

function fakeVault(): { vault: SecretVault; written: Map<string, string> } {
  const written = new Map<string, string>();
  const vault: SecretVault = {
    set: async (agentId, key, value) => {
      written.set(`${agentId}::${key}`, value);
    },
    setMany: async () => undefined,
    get: async (agentId, key) => written.get(`${agentId}::${key}`),
    listKeys: async () => [...written.keys()],
    purge: async () => undefined,
    deleteKey: async (agentId, key) => {
      written.delete(`${agentId}::${key}`);
    },
  };
  return { vault, written };
}

describe('ConductorWebhookEndpointStore', () => {
  it('create() never writes the secret to a DB column — only to the vault', async () => {
    const { pool, queries } = fakePool();
    const { vault, written } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);

    const { endpoint, secret } = await store.create({ eventId: 'orders.created', createdBy: 'operator' });

    assert.equal(endpoint.eventId, 'orders.created');
    assert.match(secret, /^[0-9a-f]{64}$/);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO conductor_webhook_endpoints'));
    assert.ok(insert);
    assert.ok(!insert!.params.includes(secret)); // the secret is not among the row's params
    assert.equal(written.get(`${CONDUCTOR_VAULT_AGENT_ID}::webhook-endpoint/${endpoint.endpointId}/secret`), secret);
  });

  it('rotateSecret() replaces the vault value and returns the new plaintext once', async () => {
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);
    const { endpoint, secret: original } = await store.create({ eventId: 'orders.created', createdBy: 'operator' });

    const rotated = await store.rotateSecret(endpoint.endpointId);

    assert.notEqual(rotated, original);
    assert.equal(await store.getSecret(endpoint.endpointId), rotated);
  });

  it('claim() dedupes a redelivered id (second claim on the same id is a duplicate)', async () => {
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);

    const first = await store.claim('delivery-1', 'ep-1', NO_RATE_LIMIT);
    const second = await store.claim('delivery-1', 'ep-1', NO_RATE_LIMIT);

    assert.equal(first, 'claimed');
    assert.equal(second, 'duplicate');
  });

  it('claim() scopes dedupe per endpoint — two endpoints can each claim the same delivery id', async () => {
    // Regression for the global-PK bug: endpoint B's delivery '1' must NOT be
    // misread as a dupe of endpoint A's delivery '1'.
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);

    const a = await store.claim('shared-id', 'ep-a', NO_RATE_LIMIT);
    const b = await store.claim('shared-id', 'ep-b', NO_RATE_LIMIT);

    assert.equal(a, 'claimed');
    assert.equal(b, 'claimed');
  });

  it('claim() rate-limits an endpoint once its rolling-window cap is reached', async () => {
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);
    const cap = { limit: 2, windowMs: 60_000 };

    const first = await store.claim('d-1', 'ep-1', cap);
    const second = await store.claim('d-2', 'ep-1', cap);
    const third = await store.claim('d-3', 'ep-1', cap);

    assert.equal(first, 'claimed');
    assert.equal(second, 'claimed');
    assert.equal(third, 'rate_limited');
  });

  it('claim() rate limit is per endpoint — a busy endpoint does not throttle another', async () => {
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);
    const cap = { limit: 1, windowMs: 60_000 };

    const busy = await store.claim('d-1', 'ep-busy', cap);
    const throttled = await store.claim('d-2', 'ep-busy', cap);
    const other = await store.claim('d-1', 'ep-other', cap);

    assert.equal(busy, 'claimed');
    assert.equal(throttled, 'rate_limited');
    assert.equal(other, 'claimed');
  });

  it('a rate-limited claim inserts no row — retrying the same delivery id costs nothing extra', async () => {
    const { pool, deliveryClaims } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);
    const cap = { limit: 0, windowMs: 60_000 };

    const result = await store.claim('d-1', 'ep-1', cap);

    assert.equal(result, 'rate_limited');
    assert.equal(deliveryClaims.size, 0);
  });
});
