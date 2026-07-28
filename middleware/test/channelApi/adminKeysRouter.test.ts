import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createAdminKeysRouter } from '../../packages/harness-channel-api/src/adminKeysRouter.js';
import { createApiKeyStore } from '../../packages/harness-channel-api/src/apiKeyStore.js';
import { createFakeSecrets } from './testSecrets.js';

/**
 * Router-level coverage for key lifecycle. Auth itself is NOT this router's
 * concern (see the doc comment in adminKeysRouter.ts) — the kernel's session
 * gate covers that, exercised separately via publicPathsExemption.test.ts.
 */
describe('channelApi/adminKeysRouter', () => {
  let server: Server;
  let baseUrl: string;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use('/admin/keys', createAdminKeysRouter(createApiKeyStore(createFakeSecrets())));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/admin/keys`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('POST / creates a key, returning the plaintext token once + a hash-free record', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { token: string; key: Record<string, unknown> };
    assert.ok(body.token.startsWith('omk_'));
    assert.equal(body.key['label'], 'ci');
    assert.ok(!('hash' in body.key));
  });

  it('POST / rejects an invalid body', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: -1 }),
    });
    assert.equal(res.status, 400);
  });

  it('GET / lists created keys without their hash', async () => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'listed' }),
    });
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    assert.ok(body.keys.some((k) => k['label'] === 'listed'));
    assert.ok(body.keys.every((k) => !('hash' in k)));
  });

  it('POST /:id/revoke revokes an existing key and 404s for an unknown one', async () => {
    const created = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { key } = (await created.json()) as { key: { id: string } };

    const revoked = await fetch(`${baseUrl}/${key.id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    const revokedBody = (await revoked.json()) as { key: { revokedAt?: number } };
    assert.equal(typeof revokedBody.key.revokedAt, 'number');

    const missing = await fetch(`${baseUrl}/does-not-exist/revoke`, { method: 'POST' });
    assert.equal(missing.status, 404);
  });
});
