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
  const deliveryClaims = new Set<string>();
  const client = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
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
      if (s.startsWith('INSERT INTO conductor_webhook_inbound_deliveries')) {
        const [deliveryId] = params as [string];
        if (deliveryClaims.has(deliveryId)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
        deliveryClaims.add(deliveryId);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const pool = { query: client.query, connect: async () => ({ ...client, release: () => undefined }) } as unknown as Pool;
  return { pool, queries, deliveryClaims };
}

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

  it('claim() dedupes a redelivered id (second claim on the same id fails)', async () => {
    const { pool } = fakePool();
    const { vault } = fakeVault();
    const store = new ConductorWebhookEndpointStore(pool, vault);

    const first = await store.claim('delivery-1', 'ep-1');
    const second = await store.claim('delivery-1', 'ep-1');

    assert.equal(first, true);
    assert.equal(second, false);
  });
});
