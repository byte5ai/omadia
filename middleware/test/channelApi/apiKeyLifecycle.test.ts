import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { createAdminKeysRouter } from '../../packages/harness-channel-api/src/adminKeysRouter.js';
import {
  isKnownScope,
  listApiKeyScopes,
  registerApiKeyScope,
} from '../../packages/harness-api-key-auth/src/apiKeyScopeCatalog.js';
import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import type {
  OperatorAdminAuditEntry,
  OperatorAuthAccessor,
} from '../../packages/plugin-api/src/index.js';
import {
  createInProcessClient,
  type InProcessClient,
  type InProcessResponse,
} from '../support/inProcessHttp.js';
import { createFakeSecrets } from './testSecrets.js';

const HOUR = 60 * 60 * 1000;

describe('#1327 — API-key scope catalog', () => {
  it('knows the built-in scopes and mcp:write:<tool>, not well-formed inventions', () => {
    for (const scope of ['chat:write', 'mcp:list', 'mcp:invoke', '*', 'mcp:write:create_lead']) {
      assert.equal(isKnownScope(scope), true, scope);
    }
    for (const scope of ['foo:bar', 'chat:wirte', 'mcp:lsit', 'mcp:write', 'Chat:Write', 42]) {
      assert.equal(isKnownScope(scope), false, String(scope));
    }
  });

  it('a plugin-registered scope is known until its last registration is disposed', () => {
    const disposeA = registerApiKeyScope('reports:read');
    const disposeB = registerApiKeyScope('reports:read');
    assert.equal(isKnownScope('reports:read'), true);
    assert.ok(listApiKeyScopes().scopes.includes('reports:read'));
    disposeA();
    disposeA(); // idempotent: must not drop B's registration
    assert.equal(isKnownScope('reports:read'), true);
    disposeB();
    assert.equal(isKnownScope('reports:read'), false);
  });

  it('refuses to register a malformed, wildcard or per-tool write scope', () => {
    assert.throws(() => registerApiKeyScope('nonsense'));
    assert.throws(() => registerApiKeyScope('*'));
    assert.throws(() => registerApiKeyScope('mcp:write:x'));
  });
});

describe('#1328 — key store: expiry, owner, delete', () => {
  it('verify() refuses an expired key and accepts it before expiry', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      const { token, record } = await store.create({ expiresAt: t0 + HOUR });
      assert.equal(record.expiresAt, t0 + HOUR);
      assert.ok(await store.verify(token), 'valid before expiry');
      Date.now = () => t0 + HOUR;
      assert.equal(await store.verify(token), undefined, 'refused at/after expiry');
    } finally {
      Date.now = realNow;
    }
  });

  it('create() throws on a past expiry (the HTTP boundary answers 400 first)', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    await assert.rejects(store.create({ expiresAt: Date.now() - 1 }));
  });

  it('a corrupt persisted expiresAt fails closed (treated as expired)', async () => {
    const secrets = createFakeSecrets();
    const store = createApiKeyStore(secrets);
    const { token, record } = await store.create({});
    const raw = JSON.parse((await secrets.get(`key:${record.id}`)) as string) as Record<string, unknown>;
    await secrets.set!(`key:${record.id}`, JSON.stringify({ ...raw, expiresAt: 'tomorrow' }));
    assert.equal(await store.verify(token), undefined);
  });

  it('a malformed persisted createdBy reads as owner unknown', async () => {
    const secrets = createFakeSecrets();
    const store = createApiKeyStore(secrets);
    const { record } = await store.create({});
    const raw = JSON.parse((await secrets.get(`key:${record.id}`)) as string) as Record<string, unknown>;
    await secrets.set!(`key:${record.id}`, JSON.stringify({ ...raw, createdBy: { email: 42 } }));
    assert.equal((await store.list())[0]?.createdBy, undefined);
  });

  it('records the creating operator', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const { record } = await store.create({ createdBy: { userId: 'u-1', email: 'op@example.com' } });
    assert.deepEqual(record.createdBy, { userId: 'u-1', email: 'op@example.com' });
  });

  it('delete() refuses an active key and removes a revoked one', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const { record } = await store.create({ label: 'gone' });
    assert.equal((await store.delete(record.id)).status, 'active');
    assert.equal((await store.list()).length, 1);
    await store.revoke(record.id);
    assert.equal((await store.delete(record.id)).status, 'deleted');
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.delete(record.id)).status, 'not_found');
  });
});

describe('#1329 — usage log: per-key reads and last used', () => {
  it('forKey() returns one key\'s entries newest first; lastUsed() survives the cap', async () => {
    const log = createAuditLog(createFakeSecrets());
    await log.record({ keyId: 'a', route: '/chat', method: 'POST', at: 1, status: 'ok' });
    await log.record({ keyId: 'b', route: '/chat', method: 'POST', at: 2, status: 'forbidden' });
    await log.record({ keyId: 'a', route: '/chat', method: 'POST', at: 3, status: 'error' });
    assert.deepEqual(
      (await log.forKey('a')).map((e) => e.at),
      [3, 1],
    );
    for (let i = 0; i < 250; i++) {
      await log.record({ keyId: 'b', route: '/chat', method: 'POST', at: 10 + i, status: 'ok' });
    }
    assert.deepEqual(await log.forKey('a'), [], 'a\'s entries were capped out');
    assert.equal((await log.lastUsed())['a'], 3, 'but its last use is still known');
  });

  it('reads the legacy bare-array vault entry', async () => {
    const secrets = createFakeSecrets();
    await secrets.set!(
      'usage-audit-log',
      JSON.stringify([{ keyId: 'old', route: '/chat', method: 'POST', at: 7, status: 'ok' }]),
    );
    const log = createAuditLog(secrets);
    assert.equal((await log.list()).length, 1);
    assert.equal((await log.lastUsed())['old'], 7);
    await log.record({ keyId: 'new', route: '/chat', method: 'POST', at: 8, status: 'ok' });
    assert.equal((await log.list()).length, 2, 'the legacy entries are carried over');
  });

  it('forget() drops a key\'s last-used stamp but keeps its entries as evidence', async () => {
    const log = createAuditLog(createFakeSecrets());
    await log.record({ keyId: 'a', route: '/chat', method: 'POST', at: 1, status: 'ok' });
    await log.record({ keyId: 'b', route: '/chat', method: 'POST', at: 2, status: 'ok' });
    await log.forget('a');
    assert.deepEqual((await log.list()).map((e) => e.keyId), ['a', 'b']);
    assert.equal((await log.lastUsed())['a'], undefined);
  });
});

/** Valid-session stub that also records the audit rows the router asks for. */
function auditingOperatorAuth(rows: OperatorAdminAuditEntry[]): OperatorAuthAccessor {
  return {
    async hasValidSession() {
      return true;
    },
    async sessionPrincipal() {
      return { userId: '00000000-0000-4000-8000-000000000001', email: 'op@example.com' };
    },
    async recordAdminAction(_cookie, entry) {
      rows.push(entry);
      return true;
    },
  };
}

describe('#1327–#1329 — admin keys router', () => {
  let client: InProcessClient;
  let rows: OperatorAdminAuditEntry[];
  let usage: ReturnType<typeof createAuditLog>;
  const json = { 'content-type': 'application/json' };

  before(() => {
    rows = [];
    usage = createAuditLog(createFakeSecrets());
    const app = express();
    app.use(express.json());
    app.use(
      '/admin/keys',
      createAdminKeysRouter(createApiKeyStore(createFakeSecrets()), auditingOperatorAuth(rows), {
        usageLog: usage,
        log: () => undefined,
      }),
    );
    client = createInProcessClient(app);
  });

  beforeEach(() => {
    rows.length = 0;
  });

  async function create(body: Record<string, unknown>): Promise<InProcessResponse> {
    return client.fetch('/admin/keys', { method: 'POST', headers: json, body: JSON.stringify(body) });
  }

  it('POST with an unknown but well-formed scope → 400 invalid_scope naming it', async () => {
    const res = await create({ label: 'typo', scopes: ['chat:write', 'foo:bar'] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; scopes: string[] };
    assert.equal(body.error, 'invalid_scope');
    assert.deepEqual(body.scopes, ['foo:bar']);
    assert.deepEqual(rows, [], 'nothing minted, nothing audited');
  });

  it('POST bounds the scope list (count and length)', async () => {
    assert.equal((await create({ scopes: Array.from({ length: 65 }, () => 'chat:write') })).status, 400);
    assert.equal((await create({ scopes: [`mcp:write:${'a'.repeat(200)}`] })).status, 400);
  });

  it('POST with MCP scopes succeeds (the UI can now mint an MCP key)', async () => {
    const res = await create({ scopes: ['mcp:list', 'mcp:invoke', 'mcp:write:create_lead'] });
    assert.equal(res.status, 201);
  });

  it('GET /scopes serves the catalog', async () => {
    const res = await client.fetch('/admin/keys/scopes');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { scopes: string[]; mcpWritePrefix: string };
    assert.deepEqual(body.scopes.slice(0, 4), ['chat:write', 'mcp:list', 'mcp:invoke', '*']);
    assert.equal(body.mcpWritePrefix, 'mcp:write:');
  });

  it('POST rejects a past or absurdly far expiry', async () => {
    assert.equal((await create({ expiresAt: Date.now() - 1000 })).status, 400);
    assert.equal((await create({ expiresAt: Date.now() + 10 * 366 * 24 * HOUR })).status, 400);
  });

  it('POST stores owner + expiry and writes an api_key.create row without the token', async () => {
    const expiresAt = Date.now() + HOUR;
    const res = await create({ label: 'owned', expiresAt });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      token: string;
      key: { id: string; expiresAt: number; createdBy: { email: string } };
    };
    assert.equal(body.key.expiresAt, expiresAt);
    assert.equal(body.key.createdBy.email, 'op@example.com');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, 'api_key.create');
    assert.equal(rows[0]?.target, `api-key:${body.key.id}`);
    const serialized = JSON.stringify(rows[0]);
    assert.ok(!serialized.includes(body.token), 'audit row never carries the token');
    assert.ok(!serialized.includes('hash'), 'audit row never carries the hash');
  });

  it('two concurrent revokes of one key write a single api_key.revoke row', async () => {
    const { key } = (await (await create({ label: 'race' })).json()) as { key: { id: string } };
    rows.length = 0;
    const results = await Promise.all([
      client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' }),
      client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(rows.map((r) => r.action), ['api_key.revoke']);
  });

  it('revoke writes one api_key.revoke row; a repeat revoke writes none', async () => {
    const { key } = (await (await create({ label: 'r' })).json()) as { key: { id: string } };
    rows.length = 0;
    assert.equal((await client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' })).status, 200);
    assert.equal((await client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' })).status, 200);
    assert.deepEqual(rows.map((r) => r.action), ['api_key.revoke']);
  });

  it('DELETE: 409 while active, 204 once revoked (audited, usage forgotten), then 404', async () => {
    const { key } = (await (await create({ label: 'd' })).json()) as { key: { id: string } };
    await usage.record({ keyId: key.id, route: '/chat', method: 'POST', at: 5, status: 'ok' });
    assert.equal((await client.fetch(`/admin/keys/${key.id}`, { method: 'DELETE' })).status, 409);
    await client.fetch(`/admin/keys/${key.id}/revoke`, { method: 'POST' });
    rows.length = 0;
    assert.equal((await client.fetch(`/admin/keys/${key.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(rows.map((r) => r.action), ['api_key.delete']);
    assert.equal((await usage.lastUsed())[key.id], undefined, 'last-used stamp dropped');
    assert.equal((await usage.forKey(key.id)).length, 1, 'request history kept');
    assert.equal((await client.fetch(`/admin/keys/${key.id}`, { method: 'DELETE' })).status, 404);
  });

  it('GET /:id/usage returns that key\'s entries; GET / carries lastUsedAt', async () => {
    const { key } = (await (await create({ label: 'u' })).json()) as { key: { id: string } };
    await usage.record({ keyId: key.id, route: '/chat', method: 'POST', at: 42, status: 'ok' });
    const res = await client.fetch(`/admin/keys/${key.id}/usage`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ at: number }> };
    assert.deepEqual(body.entries.map((e) => e.at), [42]);
    const list = (await (await client.fetch('/admin/keys')).json()) as {
      keys: Array<{ id: string; lastUsedAt?: number }>;
    };
    assert.equal(list.keys.find((k) => k.id === key.id)?.lastUsedAt, 42);
    assert.equal((await client.fetch('/admin/keys/no-such-key/usage')).status, 404);
  });
});
