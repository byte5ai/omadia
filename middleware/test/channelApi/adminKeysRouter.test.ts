import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createAdminKeysRouter } from '../../packages/harness-channel-api/src/adminKeysRouter.js';
import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import type { OperatorAuthAccessor } from '../../packages/plugin-api/src/index.js';
import { createOperatorAuthAccessor } from '../../src/auth/operatorAuthAccessor.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { createFakeSecrets } from './testSecrets.js';

/** Always-valid stub — used by the CRUD tests below, which exercise the
 *  route handlers themselves, not the auth gate (that has its own describe
 *  block further down, against the REAL operatorAuth implementation). */
function alwaysValidOperatorAuth(): OperatorAuthAccessor {
  return { async hasValidSession() { return true; } };
}

/**
 * Router-level coverage for key lifecycle, mounted BEHIND a (stubbed-valid)
 * operator-auth gate — mirrors how `plugin.ts` actually wires the router in
 * production. The gate's real behaviour (401/503 paths, real session
 * verification) is exercised separately below, and via
 * `publicPathsExemption.test.ts` for the `publicPaths.ts` side of the story.
 */
describe('channelApi/adminKeysRouter — CRUD (auth stubbed valid)', () => {
  let server: Server;
  let baseUrl: string;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use(
      '/admin/keys',
      createAdminKeysRouter(createApiKeyStore(createFakeSecrets()), alwaysValidOperatorAuth()),
    );
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

  it('POST / accepts a scope set, and GET / shows it (issue #439)', async () => {
    const created = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'scoped', scopes: ['chat:write', 'memory:read'] }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { key: { id: string; scopes: string[] } };
    assert.deepEqual(body.key.scopes, ['chat:write', 'memory:read']);

    const listed = (await (await fetch(baseUrl)).json()) as {
      keys: Array<{ id: string; scopes: string[] }>;
    };
    assert.deepEqual(
      listed.keys.find((k) => k.id === body.key.id)?.scopes,
      ['chat:write', 'memory:read'],
    );
  });

  it('POST / rejects an explicitly empty scope array with 400, never a defaulted key (issue #439)', async () => {
    // Regression guard for a create/read divergence: `normalizeScopes` denies
    // a persisted `[]`, so creation must not quietly turn it into the legacy
    // `chat:write` default. An operator asking for zero capabilities must get
    // an error, not a chat-capable key — and not a permanently-403 one either.
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'readonly', scopes: [] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'invalid_request');

    // ...and nothing was minted under that label.
    const listed = (await (await fetch(baseUrl)).json()) as {
      keys: Array<{ label?: string }>;
    };
    assert.ok(!listed.keys.some((k) => k.label === 'readonly'));
  });

  it('POST / without scopes still mints a working, chat-capable key (backward compatible)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'unscoped' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { key: { scopes: string[] } };
    assert.deepEqual(body.key.scopes, ['chat:write']);
  });

  it('POST / 400s on a malformed scope instead of 500-ing out of the store', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['nope'] }),
    });
    assert.equal(res.status, 400);
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

/**
 * The security-critical coverage that was missing before this fixup: a REAL
 * end-to-end auth gate, wired exactly like production (`createAdminKeysRouter`
 * behind the REAL `createOperatorAuthAccessor`, which itself wraps the exact
 * same `evaluateSessionToken` logic `requireAuth` uses for every other
 * `/api/v1/*` route). No stubbing of the auth decision anywhere in this block.
 */
describe('channelApi/adminKeysRouter — operator-session auth (real verification)', () => {
  const signingKey = new TextEncoder().encode('adminKeysRouter-auth-test-signing-key-32b!!');
  const whitelist = new EmailWhitelist('operator@example.com');
  const operatorAuth = createOperatorAuthAccessor({ signingKey, whitelist });

  let server: Server;
  let baseUrl: string;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use(
      '/admin/keys',
      createAdminKeysRouter(createApiKeyStore(createFakeSecrets()), operatorAuth),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/admin/keys`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('no Cookie header → 401 auth.missing', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'auth.missing');
  });

  it('garbage/invalid cookie value → 401 auth.invalid', async () => {
    const res = await fetch(baseUrl, {
      headers: { cookie: 'omadia_session=not-a-real-jwt' },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'auth.invalid');
  });

  it('valid session cookie → reaches the handler (200)', async () => {
    const token = await signSession(
      {
        sub: 'operator-1',
        email: 'operator@example.com',
        display_name: 'Operator',
        provider: 'local',
        role: 'admin',
      },
      signingKey,
    );
    const res = await fetch(baseUrl, {
      headers: { cookie: `omadia_session=${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: unknown[] };
    assert.ok(Array.isArray(body.keys));
  });

  it('an Entra-provider session whose email fell off the whitelist → 401 auth.invalid (not_whitelisted collapses to invalid at the boolean accessor)', async () => {
    const token = await signSession(
      {
        sub: 'not-whitelisted-1',
        email: 'stranger@example.com',
        display_name: 'Stranger',
        provider: 'entra',
        role: 'admin',
      },
      signingKey,
    );
    const res = await fetch(baseUrl, {
      headers: { cookie: `omadia_session=${token}` },
    });
    assert.equal(res.status, 401);
  });

  it('the #439 scopes surface is BEHIND the gate too — an anonymous POST with scopes mints nothing', async () => {
    // Guards the rebase of #439 onto this gate: the scoped create/list path
    // must sit on top of the operator-session check, never beside it. A
    // caller that can mint `scopes: ['*']` without a session would be the
    // worst possible version of this router.
    const anonymous = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'anonymous-wildcard', scopes: ['*'] }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { code: string }).code, 'auth.missing');

    const token = await signSession(
      {
        sub: 'operator-1',
        email: 'operator@example.com',
        display_name: 'Operator',
        provider: 'local',
        role: 'admin',
      },
      signingKey,
    );
    const listed = (await (
      await fetch(baseUrl, { headers: { cookie: `omadia_session=${token}` } })
    ).json()) as { keys: Array<{ label?: string }> };
    assert.equal(
      listed.keys.some((k) => k.label === 'anonymous-wildcard'),
      false,
      'the rejected POST must not have created a key',
    );
  });
});

/**
 * Fail-closed contract (finding #3): a plugin host that never wires
 * `ctx.operatorAuth` must NOT fall back to mounting the router with no auth
 * check — every route must refuse to serve.
 */
describe('channelApi/adminKeysRouter — fails closed without operatorAuth', () => {
  let server: Server;
  let baseUrl: string;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use(
      '/admin/keys',
      createAdminKeysRouter(createApiKeyStore(createFakeSecrets()), undefined),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/admin/keys`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET / → 503 operator_auth.unavailable, even with no cookie at all', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'operator_auth.unavailable');
  });

  it('POST / → 503 operator_auth.unavailable — never falls through to create a key', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'should-never-be-created' }),
    });
    assert.equal(res.status, 503);
  });
});
