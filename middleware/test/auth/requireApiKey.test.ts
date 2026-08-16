import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-api-key-auth/src/rateLimiter.js';
import { requireApiKey } from '../../packages/harness-api-key-auth/src/requireApiKey.js';
import { createFakeSecrets } from '../channelApi/testSecrets.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Issue #439 — the reusable half of the story: any route, kernel or plugin,
 * can mount `requireApiKey` and be authenticated by a server-to-server bearer
 * key instead of the `omadia_session` cookie. Mirrors the router-level
 * fixture style of `test/channelApi/chatRouter.test.ts`.
 */
async function startGuardedServer(opts: {
  scope?: string;
  withRateLimiter?: boolean;
}): Promise<{
  baseUrl: string;
  apiKeys: ReturnType<typeof createApiKeyStore>;
  auditLog: ReturnType<typeof createAuditLog>;
  secrets: ReturnType<typeof createFakeSecrets>;
  close: () => Promise<void>;
}> {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const auditLog = createAuditLog(secrets);

  const app = express();
  app.use(express.json());
  app.get(
    '/guarded',
    requireApiKey({
      apiKeys,
      auditLog,
      ...(opts.withRateLimiter ? { rateLimiter: createRateLimiter() } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
      routeLabel: '/guarded',
    }),
    (req, res) => {
      req.apiKey?.audit('ok');
      res.json({ keyId: req.apiKey?.keyId, scopes: req.apiKey?.scopes });
    },
  );
  const server: Server = await listenLoopback(app);
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}/guarded`,
    apiKeys,
    auditLog,
    secrets,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('auth/requireApiKey — authentication', () => {
  let harness: Awaited<ReturnType<typeof startGuardedServer>>;

  before(async () => {
    harness = await startGuardedServer({});
  });
  after(async () => {
    await harness.close();
  });

  it('401s with the public-API error shape when no Authorization header is sent', async () => {
    const res = await fetch(harness.baseUrl);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: 'unauthorized',
      message: 'missing Authorization: Bearer <api-key> header',
    });
  });

  it('401s for a non-Bearer scheme and for an empty bearer value', async () => {
    const basic = await fetch(harness.baseUrl, { headers: { authorization: 'Basic abc' } });
    assert.equal(basic.status, 401);
    const empty = await fetch(harness.baseUrl, { headers: { authorization: 'Bearer   ' } });
    assert.equal(empty.status, 401);
  });

  it('401s for an unknown key', async () => {
    const res = await fetch(harness.baseUrl, {
      headers: { authorization: 'Bearer omk_not-a-real-key' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: 'unauthorized',
      message: 'invalid or revoked API key',
    });
  });

  it('passes a valid key through and exposes the principal on req.apiKey', async () => {
    const created = await harness.apiKeys.create({ label: 'laravel-app' });
    const res = await fetch(harness.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      keyId: created.record.id,
      scopes: ['chat:write'],
    });
  });

  it('401s once the key is revoked, on the very next request', async () => {
    const created = await harness.apiKeys.create({ label: 'short-lived' });
    assert.equal(
      (await fetch(harness.baseUrl, { headers: { authorization: `Bearer ${created.token}` } }))
        .status,
      200,
    );
    await harness.apiKeys.revoke(created.record.id);
    assert.equal(
      (await fetch(harness.baseUrl, { headers: { authorization: `Bearer ${created.token}` } }))
        .status,
      401,
    );
  });

  it('does not audit an unauthenticated call — there is no caller identity to attribute', async () => {
    const local = await startGuardedServer({});
    await fetch(local.baseUrl);
    await fetch(local.baseUrl, { headers: { authorization: 'Bearer omk_nope' } });
    assert.equal((await local.auditLog.list()).length, 0);
    await local.close();
  });
});

describe('auth/requireApiKey — scopes', () => {
  it('403s a key that lacks the required scope, and audits it as forbidden', async () => {
    const local = await startGuardedServer({ scope: 'memory:read' });
    const created = await local.apiKeys.create({ label: 'chat-only' });

    const res = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: 'forbidden',
      message: "this API key is not scoped for 'memory:read'",
    });

    const entries = await local.auditLog.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, 'forbidden');
    assert.equal(entries[0]?.keyId, created.record.id);
    await local.close();
  });

  it('lets a key with the exact scope through', async () => {
    const local = await startGuardedServer({ scope: 'memory:read' });
    const created = await local.apiKeys.create({ scopes: ['memory:read'] });
    const res = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(res.status, 200);
    await local.close();
  });

  it('lets a wildcard key through any scope gate', async () => {
    const local = await startGuardedServer({ scope: 'memory:read' });
    const created = await local.apiKeys.create({ scopes: ['*'] });
    const res = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(res.status, 200);
    await local.close();
  });

  it('authenticates without any scope gate when `scope` is omitted', async () => {
    const local = await startGuardedServer({});
    const created = await local.apiKeys.create({ scopes: ['memory:read'] });
    const res = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(res.status, 200);
    await local.close();
  });

  it('403s a key whose PERSISTED scopes field is malformed, instead of granting it the legacy default', async () => {
    // The end-to-end shape of the fail-open this replaced: a vault record
    // whose `scopes` is a bare string (or wrong-cased, or partially valid)
    // used to hydrate to `['chat:write']`, so a key deliberately restricted
    // away from chat authenticated against a `chat:write` route.
    for (const corrupt of ['memory:read', ['Chat:Write'], ['chat:write', 'nonsense'], []]) {
      const local = await startGuardedServer({ scope: 'chat:write' });
      const created = await local.apiKeys.create({ label: 'restricted', scopes: ['memory:read'] });
      const raw = await local.secrets.get(`key:${created.record.id}`);
      assert.ok(raw);
      await local.secrets.set?.(
        `key:${created.record.id}`,
        JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), scopes: corrupt }),
      );

      const res = await fetch(local.baseUrl, {
        headers: { authorization: `Bearer ${created.token}` },
      });
      assert.equal(res.status, 403, `scopes=${JSON.stringify(corrupt)} must not reach the handler`);
      assert.deepEqual(
        (await local.auditLog.list()).map((e) => e.status),
        ['forbidden'],
        'the denial is attributable to the key',
      );
      await local.close();
    }
  });
});

describe('auth/requireApiKey — rate limiting', () => {
  it('429s past the per-key budget and audits it, without invoking the handler', async () => {
    const local = await startGuardedServer({ withRateLimiter: true });
    const created = await local.apiKeys.create({ rateLimitPerMinute: 1 });

    const first = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(first.status, 200);

    const second = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), {
      error: 'rate_limited',
      message: 'this key is limited to 1 requests/minute',
    });

    const entries = await local.auditLog.list();
    assert.deepEqual(
      entries.map((e) => e.status),
      ['ok', 'rate_limited'],
    );
    assert.equal(entries[0]?.route, '/guarded');
    assert.equal(entries[0]?.method, 'GET');
    await local.close();
  });

  it('burns quota before the scope check, so scope probing is not free', async () => {
    const local = await startGuardedServer({ withRateLimiter: true, scope: 'memory:read' });
    const created = await local.apiKeys.create({ rateLimitPerMinute: 1, scopes: ['chat:write'] });

    const first = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(first.status, 403, 'no scope → forbidden');
    const second = await fetch(local.baseUrl, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    assert.equal(second.status, 429, 'the forbidden call still consumed the budget');
    await local.close();
  });
});
