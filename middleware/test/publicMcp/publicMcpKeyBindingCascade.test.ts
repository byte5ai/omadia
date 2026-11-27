import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import { createAdminKeysRouter } from '../../packages/harness-channel-api/src/adminKeysRouter.js';
import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createPublicMcpKeyBindingCascade } from '../../src/mcp/publicMcpKeyBindingCascade.js';
import { createInMemoryPublicMcpKeyBindingAdminStore } from '../../src/mcp/publicMcpKeyBindingsAdmin.js';
import { createFakeSecrets } from '../channelApi/testSecrets.js';
import { createInProcessClient } from '../support/inProcessHttp.js';

/** #2310 / ADR-0273 — deleting an API key drops its public MCP binding. */
describe('public MCP key-binding cascade (#2310)', () => {
  async function bindingStoreWith(keyId: string) {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await store.upsert({ keyId, agentId: 'sales', readTools: ['query_crm'], writeTools: [] });
    return store;
  }

  it('removes the binding of a key the vault no longer holds', async () => {
    const store = await bindingStoreWith('k-1');
    const cascade = createPublicMcpKeyBindingCascade({
      bindings: () => store,
      keyIds: async () => new Set(),
      log: () => {},
    });
    assert.equal(await cascade.forgetDeletedKey('k-1'), 'removed');
    assert.equal((await store.list()).length, 0);
    assert.equal(await cascade.forgetDeletedKey('k-1'), 'none');
  });

  it('keeps the binding of a key that still exists', async () => {
    const store = await bindingStoreWith('k-2');
    const cascade = createPublicMcpKeyBindingCascade({
      bindings: () => store,
      keyIds: async () => new Set(['k-2']),
      log: () => {},
    });
    assert.equal(await cascade.forgetDeletedKey('k-2'), 'key_exists');
    assert.equal((await store.list()).length, 1);
  });

  it('keeps the binding when the vault cannot be read', async () => {
    const store = await bindingStoreWith('k-3');
    const cascade = createPublicMcpKeyBindingCascade({
      bindings: () => store,
      keyIds: async () => {
        throw new Error('vault locked');
      },
      log: () => {},
    });
    assert.equal(await cascade.forgetDeletedKey('k-3'), 'unavailable');
    assert.equal((await store.list()).length, 1);
  });

  it('the key-delete route calls the cascade after a delete, not for an active key', async () => {
    const secrets = createFakeSecrets();
    const apiKeys = createApiKeyStore(secrets);
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    const cascade = createPublicMcpKeyBindingCascade({
      bindings: () => store,
      keyIds: async () => new Set((await apiKeys.list()).map((k) => k.id)),
      log: () => {},
    });
    const forgotten: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(
      '/admin/keys',
      createAdminKeysRouter(apiKeys, { async hasValidSession() { return true; } }, {
        onKeyDeleted: async (id) => {
          forgotten.push(id);
          await cascade.forgetDeletedKey(id);
        },
      }),
    );
    const client = createInProcessClient(app);
    const created = await client.fetch('/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { key } = (await created.json()) as { key: { id: string } };
    await store.upsert({ keyId: key.id, agentId: 'sales', readTools: ['query_crm'], writeTools: [] });

    const refused = await client.fetch(`/admin/keys/${key.id}`, { method: 'DELETE' });
    assert.equal(refused.status, 409, 'an active key is not deleted');
    assert.deepEqual(forgotten, []);

    await client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' });
    const deleted = await client.fetch(`/admin/keys/${key.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.deepEqual(forgotten, [key.id]);
    assert.equal((await store.list()).length, 0, 'the binding went with the key');
  });
});
