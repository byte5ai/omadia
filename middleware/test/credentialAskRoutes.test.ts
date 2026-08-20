/**
 * #578 Phase 3 — the HTTP surface for keychain-asks, end to end against a
 * real Express app (`app.listen(0, ...)` + real `fetch`), the same pattern
 * `adminProvidersRoute.test.ts` uses. Not mounted into the live server yet
 * (see `credentialAsks.ts`'s header) — this test mounts it itself.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { InMemoryCredentialStore, type EncryptedSecretMaterial } from '@omadia/channel-sdk';
import express, { type Express } from 'express';

import { InMemoryCredentialAskStore } from '../src/credentials/asks.js';
import { createCredentialAskRouter } from '../src/routes/credentialAsks.js';

function fakeSeal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}
function fakeUnseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

describe('#578 credential ask routes', () => {
  let server: Server;
  let baseUrl: string;
  let credStore: InMemoryCredentialStore;
  let credentialId: string;

  before(async () => {
    credStore = new InMemoryCredentialStore(fakeSeal, fakeUnseal);
    const cred = await credStore.createCredential({
      name: 'personal-github-token',
      kind: 'personal',
      owner: { kind: 'user', userId: 'owner@example.com' },
      secret: 'shh',
      createdBy: 'op',
    });
    credentialId = cred.id;

    const askStore = new InMemoryCredentialAskStore(credStore);
    const app: Express = express();
    app.use(express.json());
    app.use('/api/v1/credential-asks', createCredentialAskRouter({ store: askStore }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${String(port)}/api/v1/credential-asks`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('rejects a create with missing fields', async () => {
    const { status, body } = await postJson('/', { credentialId });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.invalid_input');
  });

  it('creates an ask, lists it for the owner, approves it, and the grant becomes visible', async () => {
    const create = await postJson('/', {
      credentialId,
      requesterUserId: 'alice@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'need it for a script',
      mode: 'standing',
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.status, 'pending');
    const askId = create.body.id as string;

    const pending = await getJson('/pending?owner=owner@example.com');
    assert.equal(pending.status, 200);
    const asks = pending.body.asks as Array<Record<string, unknown>>;
    assert.ok(asks.some((a) => a.id === askId));

    const approve = await postJson(`/${askId}/approve`, { resolvedBy: 'owner@example.com' });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, 'approved');
    assert.ok(approve.body.grant_id);

    const active = await credStore.activeGrant(credentialId, { kind: 'user', userId: 'alice@example.com' }, new Date());
    assert.ok(active, 'the HTTP-level approval must have created a real, usable grant');
  });

  it('a "once" create without requestedGrantExpiresAt is rejected before it ever reaches the store', async () => {
    const { status, body } = await postJson('/', {
      credentialId,
      requesterUserId: 'alice@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'one-off',
      mode: 'once',
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'credential_ask.invalid_input');
  });

  it('approving an already-resolved ask returns 409, not a silent success', async () => {
    const create = await postJson('/', {
      credentialId,
      requesterUserId: 'bob@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'test',
      mode: 'standing',
    });
    const askId = create.body.id as string;
    const deny = await postJson(`/${askId}/deny`, { resolvedBy: 'owner@example.com' });
    assert.equal(deny.status, 200);

    const secondTry = await postJson(`/${askId}/approve`, { resolvedBy: 'owner@example.com' });
    assert.equal(secondTry.status, 409);
    assert.equal(secondTry.body.code, 'credential_ask.not_actionable');
  });

  it('mine lists only the requester\'s own asks', async () => {
    await postJson('/', {
      credentialId,
      requesterUserId: 'carol@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'carol test',
      mode: 'standing',
    });
    const mine = await getJson('/mine?requester=carol@example.com');
    const asks = mine.body.asks as Array<Record<string, unknown>>;
    assert.ok(asks.length >= 1);
    assert.ok(asks.every((a) => a.requester === 'carol@example.com'));
  });

  it('cancel only works for the original requester', async () => {
    const create = await postJson('/', {
      credentialId,
      requesterUserId: 'dave@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'dave test',
      mode: 'standing',
    });
    const askId = create.body.id as string;

    const wrongCanceller = await postJson(`/${askId}/cancel`, { requesterUserId: 'eve@example.com' });
    assert.equal(wrongCanceller.status, 404);

    const rightCanceller = await postJson(`/${askId}/cancel`, { requesterUserId: 'dave@example.com' });
    assert.equal(rightCanceller.status, 200);
  });

  it('clamps an oversized askTtlMs to the configured maximum rather than honouring it verbatim', async () => {
    const create = await postJson('/', {
      credentialId,
      requesterUserId: 'frank@example.com',
      ownerUserId: 'owner@example.com',
      purpose: 'ttl test',
      mode: 'standing',
      askTtlMs: 999 * 24 * 60 * 60 * 1000, // absurdly long
    });
    assert.equal(create.status, 201);
    const askExpiresAt = new Date(create.body.ask_expires_at as string);
    const maxAllowed = Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000; // default max + slack
    assert.ok(askExpiresAt.getTime() <= maxAllowed, 'must clamp to the default 7-day ceiling, not honour 999 days');
  });
});
