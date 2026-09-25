/**
 * #578 Phase 3 / #778 S1 — the HTTP surface for keychain-asks, end to end
 * against a real Express app (`app.listen(0, ...)` + real `fetch`), the same
 * pattern `adminProvidersRoute.test.ts` uses. The live mount
 * (`index.ts`, `/api/v1/admin/credential-asks` behind `requireAuth`) is
 * pinned by `778RouteMounts.wiring.test.ts`; this file mounts the router
 * itself behind a session stub standing in for `requireAuth`.
 *
 * #778 S1: every caller identity comes from `req.session.omadia_user_id`.
 * The stub sets that claim from the `x-test-user` header, and sets NO
 * session at all when the header is absent, so each case can exercise the
 * 401 path without a second app instance.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { InMemoryCredentialStore, makePrincipal, type EncryptedSecretMaterial, type Principal } from '@omadia/channel-sdk';
import express, { type Express } from 'express';

import { InMemoryCredentialAskStore, type CredentialAskStore } from '../src/credentials/asks.js';
import { createCredentialAskRouter } from '../src/routes/credentialAsks.js';

function fakeSeal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function fakeUnseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

const OWNER_ID = 'owner@example.com';
const ALICE = makePrincipal('user', 'alice@example.com') as Principal;

interface Running {
  readonly server: Server;
  readonly baseUrl: string;
}

async function startApp(store: CredentialAskStore): Promise<Running> {
  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/credential-asks', (req, _res, next) => {
    const user = req.header('x-test-user');
    const subOnly = req.header('x-test-sub-only');
    if (subOnly !== undefined) {
      // A real session whose login did not resolve an omadia_user_id.
      (req as unknown as { session?: Record<string, string> }).session = { sub: subOnly, email: subOnly };
    } else if (user !== undefined) {
      // Only the claim the router reads — the rest of `SessionClaims` is
      // deliberately absent, so a `sub`/`email` fallback would find nothing.
      (req as unknown as { session?: { omadia_user_id?: string } }).session = { omadia_user_id: user };
    }
    next();
  });
  app.use('/api/v1/credential-asks', createCredentialAskRouter({ store }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}/api/v1/credential-asks` };
}

async function stopApp(running: Running): Promise<void> {
  await new Promise((resolve) => running.server.close(() => resolve(undefined)));
}

type JsonResult = { status: number; body: Record<string, unknown> };

async function call(baseUrl: string, method: 'GET' | 'POST', path: string, user?: string, body?: unknown): Promise<JsonResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user !== undefined) headers['x-test-user'] = user;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('#578 / #778 S1 credential ask routes — identity comes from the session', () => {
  let running: Running;
  let credStore: InMemoryCredentialStore;
  let credentialId: string;
  let serviceCredentialId: string;
  let credCounter = 0;

  before(async () => {
    credStore = new InMemoryCredentialStore(fakeSeal, fakeUnseal);
    const cred = await credStore.createCredential({
      name: 'personal-github-token',
      kind: 'personal',
      owner: { kind: 'user', userId: OWNER_ID },
      secret: 'shh',
      createdBy: 'op',
    });
    credentialId = cred.id;
    const service = await credStore.createCredential({ name: 'svc', kind: 'service', secret: 's', createdBy: 'op' });
    serviceCredentialId = service.id;
    running = await startApp(new InMemoryCredentialAskStore(credStore));
  });

  after(async () => {
    await stopApp(running);
  });

  const post = (path: string, user: string | undefined, body?: unknown): Promise<JsonResult> =>
    call(running.baseUrl, 'POST', path, user, body);
  const get = (path: string, user: string | undefined): Promise<JsonResult> => call(running.baseUrl, 'GET', path, user);

  async function freshCredential(): Promise<string> {
    credCounter += 1;
    const cred = await credStore.createCredential({
      name: `personal-${String(credCounter)}`,
      kind: 'personal',
      owner: { kind: 'user', userId: OWNER_ID },
      secret: 'shh',
      createdBy: 'op',
    });
    return cred.id;
  }

  async function createAs(user: string, extra: Record<string, unknown> = {}): Promise<JsonResult> {
    return post('/', user, { credentialId, purpose: `ask by ${user}`, mode: 'standing', ...extra });
  }

  it('every route answers 401 auth.required without a session — the store is never reached', async () => {
    const results = await Promise.all([
      post('/', undefined, { credentialId, purpose: 'x', mode: 'standing' }),
      get('/pending', undefined),
      get('/mine', undefined),
      post('/some-id/approve', undefined),
      post('/some-id/deny', undefined),
      post('/some-id/cancel', undefined),
    ]);
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'auth.required');
    }
  });

  it('a whitespace-only omadia_user_id is no identity either — 401', async () => {
    const r = await get('/mine', '   ');
    assert.equal(r.status, 401);
  });

  it('no sub/email fallback: a session without omadia_user_id is 401 even when sub/email name the owner', async () => {
    const res = await fetch(`${running.baseUrl}/pending`, { headers: { 'x-test-sub-only': OWNER_ID } });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as Record<string, unknown>).code, 'auth.required');
  });

  it('rejects a create with missing fields', async () => {
    const { status, body } = await post('/', 'alice@example.com', { credentialId });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.invalid_input');
  });

  it('rejects a client-supplied requesterUserId on create — the requester is the session', async () => {
    const { status, body } = await createAs('alice@example.com', { requesterUserId: 'someone-else@example.com' });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.identity_from_session');
  });

  it('creates an ask with the session as requester and the credential owner as owner (no ownerUserId needed)', async () => {
    const { status, body } = await createAs('Alice@Example.com');
    assert.equal(status, 201);
    assert.equal(body.requester, 'alice@example.com');
    assert.equal(body.owner, OWNER_ID);
    assert.equal(body.status, 'pending');
  });

  it('accepts an ownerUserId that matches the credential owner', async () => {
    const { status, body } = await createAs('alice@example.com', { ownerUserId: 'OWNER@example.com' });
    assert.equal(status, 201);
    assert.equal(body.owner, OWNER_ID);
  });

  it('rejects an ownerUserId that is not the credential owner — 400 owner_mismatch', async () => {
    const { status, body } = await createAs('alice@example.com', { ownerUserId: 'mallory@example.com' });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.owner_mismatch');
  });

  it('rejects a non-string / blank ownerUserId as invalid input', async () => {
    const blank = await createAs('alice@example.com', { ownerUserId: '  ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.code, 'credential_ask.invalid_input');
    const numeric = await createAs('alice@example.com', { ownerUserId: 42 });
    assert.equal(numeric.status, 400);
    assert.equal(numeric.body.code, 'credential_ask.invalid_input');
  });

  it('refuses a create against a service credential and against a revoked credential (400 create_failed)', async () => {
    const service = await post('/', 'alice@example.com', {
      credentialId: serviceCredentialId,
      purpose: 'x',
      mode: 'standing',
    });
    assert.equal(service.status, 400);
    assert.equal(service.body.code, 'credential_ask.create_failed');

    const revokedId = await freshCredential();
    await credStore.revokeCredential(revokedId, 'op');
    const revoked = await post('/', 'alice@example.com', { credentialId: revokedId, purpose: 'x', mode: 'standing' });
    assert.equal(revoked.status, 400);
    assert.equal(revoked.body.code, 'credential_ask.create_failed');

    const unknown = await post('/', 'alice@example.com', { credentialId: 'nope', purpose: 'x', mode: 'standing' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'credential_ask.create_failed');
  });

  it('a "once" create without requestedGrantExpiresAt is rejected before it ever reaches the store', async () => {
    const { status, body } = await createAs('alice@example.com', { mode: 'once' });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.invalid_input');
  });

  it('a malformed requestedGrantExpiresAt is a 400 for a "standing" ask too, and never reaches the store', async () => {
    const inboxBefore = await get('/pending', OWNER_ID);
    assert.equal(inboxBefore.status, 200);
    const pendingBefore = (inboxBefore.body.asks as unknown[]).length;
    for (const bad of ['garbage', '', 1893456000000, null]) {
      const r = await createAs('alice@example.com', { requestedGrantExpiresAt: bad });
      assert.equal(r.status, 400, `requestedGrantExpiresAt=${JSON.stringify(bad)}`);
      assert.equal(r.body.code, 'credential_ask.invalid_input');
    }
    const inboxAfter = await get('/pending', OWNER_ID);
    assert.equal(inboxAfter.status, 200);
    assert.equal((inboxAfter.body.asks as unknown[]).length, pendingBefore, 'no ask was stored');
  });

  it('THE exploit: a non-owner session cannot approve — 403, and no grant is minted', async () => {
    const create = await createAs('mallory@example.com');
    const askId = create.body.id as string;

    const approve = await post(`/${askId}/approve`, 'mallory@example.com');
    assert.equal(approve.status, 403);
    assert.equal(approve.body.code, 'credential_ask.forbidden');

    const mallory = makePrincipal('user', 'mallory@example.com') as Principal;
    assert.equal(await credStore.activeGrant(credentialId, mallory, new Date()), undefined);

    const stillPending = await get('/pending', OWNER_ID);
    assert.ok((stillPending.body.asks as Array<Record<string, unknown>>).some((a) => a.id === askId));
  });

  it('a non-owner session cannot deny either — 403', async () => {
    const create = await createAs('alice@example.com');
    const deny = await post(`/${create.body.id as string}/deny`, 'mallory@example.com');
    assert.equal(deny.status, 403);
    assert.equal(deny.body.code, 'credential_ask.forbidden');
  });

  it('rejects a client-supplied resolvedBy on approve and deny', async () => {
    const create = await createAs('alice@example.com');
    const askId = create.body.id as string;
    const approve = await post(`/${askId}/approve`, OWNER_ID, { resolvedBy: OWNER_ID });
    assert.equal(approve.status, 400);
    assert.equal(approve.body.code, 'credential_ask.identity_from_session');
    const deny = await post(`/${askId}/deny`, OWNER_ID, { resolvedBy: OWNER_ID });
    assert.equal(deny.status, 400);
    assert.equal(deny.body.code, 'credential_ask.identity_from_session');
  });

  it('the owner session approves — resolved_by is the session id and the grant is usable', async () => {
    const create = await createAs('alice@example.com');
    const askId = create.body.id as string;

    const pending = await get('/pending', OWNER_ID);
    assert.equal(pending.status, 200);
    assert.ok((pending.body.asks as Array<Record<string, unknown>>).some((a) => a.id === askId));

    const approve = await post(`/${askId}/approve`, 'Owner@Example.com');
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, 'approved');
    assert.equal(approve.body.resolved_by, 'Owner@Example.com');
    assert.ok(approve.body.grant_id);

    const active = await credStore.activeGrant(credentialId, ALICE, new Date());
    assert.ok(active, 'the HTTP-level approval must have created a real, usable grant');
  });

  it('approving after the credential was revoked answers 409, closes the ask as expired, mints no grant', async () => {
    const revokedLater = await freshCredential();
    const create = await post('/', 'bob@example.com', { credentialId: revokedLater, purpose: 'x', mode: 'standing' });
    assert.equal(create.status, 201);
    const askId = create.body.id as string;
    await credStore.revokeCredential(revokedLater, 'op');

    const approve = await post(`/${askId}/approve`, OWNER_ID);
    assert.equal(approve.status, 409);
    assert.equal(approve.body.code, 'credential_ask.not_actionable');

    const mine = await get('/mine', 'bob@example.com');
    const ask = (mine.body.asks as Array<Record<string, unknown>>).find((a) => a.id === askId);
    assert.equal(ask?.status, 'expired');
    assert.deepEqual(await credStore.listGrantsForCredential(revokedLater), []);
  });

  it('approve / deny on an unknown ask id answers 404, not 409', async () => {
    const approve = await post('/does-not-exist/approve', OWNER_ID);
    assert.equal(approve.status, 404);
    assert.equal(approve.body.code, 'credential_ask.not_found');
    const deny = await post('/does-not-exist/deny', OWNER_ID);
    assert.equal(deny.status, 404);
  });

  it('approving an already-resolved ask returns 409, not a silent success', async () => {
    const create = await createAs('bob@example.com');
    const askId = create.body.id as string;
    const deny = await post(`/${askId}/deny`, OWNER_ID);
    assert.equal(deny.status, 200);
    assert.equal(deny.body.resolved_by, OWNER_ID);

    const secondTry = await post(`/${askId}/approve`, OWNER_ID);
    assert.equal(secondTry.status, 409);
    assert.equal(secondTry.body.code, 'credential_ask.not_actionable');
  });

  it('rejects ?owner on /pending and ?requester on /mine — nobody reads another inbox', async () => {
    const pending = await get(`/pending?owner=${encodeURIComponent(OWNER_ID)}`, 'mallory@example.com');
    assert.equal(pending.status, 400);
    assert.equal(pending.body.code, 'credential_ask.identity_from_session');
    const mine = await get('/mine?requester=carol@example.com', 'mallory@example.com');
    assert.equal(mine.status, 400);
    assert.equal(mine.body.code, 'credential_ask.identity_from_session');
  });

  it('/pending lists only the session owner\'s inbox; /mine only the session requester\'s asks', async () => {
    await createAs('carol@example.com');

    const notOwner = await get('/pending', 'carol@example.com');
    assert.equal(notOwner.status, 200);
    assert.deepEqual(notOwner.body.asks, []);

    const ownerInbox = await get('/pending', OWNER_ID);
    const inbox = ownerInbox.body.asks as Array<Record<string, unknown>>;
    assert.ok(inbox.length >= 1);
    assert.ok(inbox.every((a) => a.owner === OWNER_ID));

    const mine = await get('/mine', 'carol@example.com');
    const asks = mine.body.asks as Array<Record<string, unknown>>;
    assert.ok(asks.length >= 1);
    assert.ok(asks.every((a) => a.requester === 'carol@example.com'));
  });

  it('cancel only works for the session that made the ask; a body requesterUserId is rejected', async () => {
    const create = await createAs('dave@example.com');
    const askId = create.body.id as string;

    const spoofed = await post(`/${askId}/cancel`, 'eve@example.com', { requesterUserId: 'dave@example.com' });
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.code, 'credential_ask.identity_from_session');

    const wrongCanceller = await post(`/${askId}/cancel`, 'eve@example.com');
    assert.equal(wrongCanceller.status, 404);

    const rightCanceller = await post(`/${askId}/cancel`, 'dave@example.com');
    assert.equal(rightCanceller.status, 200);
  });

  it('clamps an oversized askTtlMs to the configured maximum rather than honouring it verbatim', async () => {
    const create = await createAs('frank@example.com', { askTtlMs: 999 * 24 * 60 * 60 * 1000 });
    assert.equal(create.status, 201);
    const askExpiresAt = new Date(create.body.ask_expires_at as string);
    const maxAllowed = Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000; // default max + slack
    assert.ok(askExpiresAt.getTime() <= maxAllowed, 'must clamp to the default 7-day ceiling, not honour 999 days');
  });
});

describe('#778 S1 credential ask routes — store failures are not client errors', () => {
  it('a createAsk failure that is not a domain rejection answers 500 without leaking the error text', async () => {
    const credStore = new InMemoryCredentialStore(fakeSeal, fakeUnseal);
    const inner = new InMemoryCredentialAskStore(credStore);
    const throwing: CredentialAskStore = {
      createAsk: async () => {
        throw new Error('boom: relation "credential_asks" does not exist');
      },
      getAsk: (id) => inner.getAsk(id),
      listPendingForOwner: (owner, now) => inner.listPendingForOwner(owner, now),
      listForRequester: (requester) => inner.listForRequester(requester),
      approve: (id, by, now) => inner.approve(id, by, now),
      deny: (id, by, now) => inner.deny(id, by, now),
      cancel: (id, requester) => inner.cancel(id, requester),
    };
    const running = await startApp(throwing);
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const r = await call(running.baseUrl, 'POST', '/', 'alice@example.com', {
        credentialId: 'c1',
        purpose: 'x',
        mode: 'standing',
      });
      assert.equal(r.status, 500);
      assert.equal(r.body.code, 'credential_ask.create_failed');
      assert.ok(!JSON.stringify(r.body).includes('boom'), 'internal error text must not reach the client');
    } finally {
      console.error = originalError;
      await stopApp(running);
    }
  });
});
