/**
 * #2320 — `/api/v1/admin/credentials` against a real Express app
 * (`app.listen(0)` + `fetch`) and the real `InMemoryCredentialStore`.
 *
 * Pins: no secret material or fingerprint in any body; owner-only revocation
 * for personal credentials and their grants (ADR-0102); service credentials
 * revocable by any operator; one audit row per revocation, none on refusal.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express, { type Express } from 'express';

import { InMemoryCredentialStore, makePrincipal, type Principal } from '@omadia/channel-sdk';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createAdminCredentialsRouter } from '../src/routes/adminCredentials.js';

const SECRET = 'super-secret-token-value';

function user(id: string): Principal {
  const p = makePrincipal('user', id);
  assert.ok(p);
  return p;
}

function newStore(): InMemoryCredentialStore {
  return new InMemoryCredentialStore(
    (plaintext) => ({ iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext).toString('base64') }),
    (material) => Buffer.from(material.ciphertext, 'base64').toString('utf8'),
  );
}

function buildApp(store: InMemoryCredentialStore, audit: AuditEntryInput[]): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/credentials', (req, _res, next) => {
    const as = req.header('x-test-user');
    if (as) {
      (req as typeof req & { session?: unknown }).session = {
        sub: `sub-${as}`,
        email: `${as}@example.com`,
        display_name: as,
        provider: 'local',
        role: 'admin',
        omadia_user_id: as,
      };
    }
    next();
  });
  app.use(
    '/api/v1/admin/credentials',
    createAdminCredentialsRouter({
      store,
      adminAudit: {
        record: async (entry) => {
          audit.push(entry);
        },
      },
    }),
  );
  return app;
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${String(port)}/api/v1/admin/credentials`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function call(
  url: string,
  as: string | undefined,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers: as ? { 'x-test-user': as } : {} });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function seed(store: InMemoryCredentialStore) {
  const personal = await store.createCredential({
    name: 'alice-github',
    kind: 'personal',
    owner: user('alice'),
    secret: SECRET,
    createdBy: 'alice',
  });
  const service = await store.createCredential({
    name: 'org-notion',
    kind: 'service',
    secret: SECRET,
    createdBy: 'alice',
    broker: {
      host: 'api.notion.com',
      injectionScheme: 'bearer',
      allowedMethods: ['GET'],
      pathPrefixes: ['/v1'],
    },
  });
  const grant = await store.createGrant({
    credentialId: personal.id,
    principal: user('bob'),
    mode: 'standing',
    purpose: 'sync issues',
    grantedBy: 'alice',
  });
  return { personal, service, grant };
}

describe('#2320 admin credentials route', () => {
  it('401s without a session', async () => {
    const store = newStore();
    await withServer(buildApp(store, []), async (base) => {
      const res = await call(base, undefined);
      assert.equal(res.status, 401);
      assert.equal(res.body['code'], 'auth.required');
    });
  });

  it('lists metadata only, with can_revoke following the owner rule', async () => {
    const store = newStore();
    const { personal, service } = await seed(store);
    await withServer(buildApp(store, []), async (base) => {
      const res = await call(base, 'bob');
      assert.equal(res.status, 200);
      assert.ok(!res.text.includes(SECRET), 'no plaintext secret');
      assert.ok(!res.text.includes(Buffer.from(SECRET).toString('base64')), 'no sealed material');
      assert.ok(!res.text.includes('fingerprint'), 'no fingerprint');
      const list = res.body['credentials'] as Array<Record<string, unknown>>;
      const byId = new Map(list.map((c) => [c['id'], c]));
      assert.equal(byId.get(personal.id)?.['owner'], 'user:alice');
      assert.equal(byId.get(personal.id)?.['can_revoke'], false, 'bob is not the owner');
      assert.equal(byId.get(service.id)?.['can_revoke'], true, 'service: any operator');
      assert.deepEqual((byId.get(service.id)?.['broker'] as Record<string, unknown>)['host'], 'api.notion.com');
    });
  });

  it('lists the grants of a credential and 404s an unknown id', async () => {
    const store = newStore();
    const { personal } = await seed(store);
    await withServer(buildApp(store, []), async (base) => {
      const res = await call(`${base}/${personal.id}/grants`, 'alice');
      assert.equal(res.status, 200);
      const grants = res.body['grants'] as Array<Record<string, unknown>>;
      assert.equal(grants.length, 1);
      assert.equal(grants[0]?.['principal'], 'user:bob');
      assert.equal(res.body['can_revoke_grants'], true);
      const missing = await call(`${base}/nope/grants`, 'alice');
      assert.equal(missing.status, 404);
    });
  });

  it('refuses a non-owner revoking a personal credential or its grant, without an audit row', async () => {
    const store = newStore();
    const { personal, grant } = await seed(store);
    const audit: AuditEntryInput[] = [];
    await withServer(buildApp(store, audit), async (base) => {
      const a = await call(`${base}/${personal.id}/revoke`, 'bob', 'POST');
      assert.equal(a.status, 403);
      assert.equal(a.body['code'], 'credential.forbidden');
      const b = await call(`${base}/grants/${grant.id}/revoke`, 'bob', 'POST');
      assert.equal(b.status, 403);
    });
    assert.equal((await store.getCredential(personal.id))?.revokedAt, undefined);
    assert.equal((await store.getGrant(grant.id))?.revokedAt, undefined);
    assert.equal(audit.length, 0);
  });

  it('lets the owner revoke a grant and the credential, audited, and 409s a second revoke', async () => {
    const store = newStore();
    const { personal, grant } = await seed(store);
    const audit: AuditEntryInput[] = [];
    await withServer(buildApp(store, audit), async (base) => {
      const g = await call(`${base}/grants/${grant.id}/revoke`, 'alice', 'POST');
      assert.equal(g.status, 200);
      assert.ok((g.body['grant'] as Record<string, unknown>)['revoked_at']);
      const c = await call(`${base}/${personal.id}/revoke`, 'alice', 'POST');
      assert.equal(c.status, 200);
      assert.equal((c.body['credential'] as Record<string, unknown>)['can_revoke'], false);
      const again = await call(`${base}/${personal.id}/revoke`, 'alice', 'POST');
      assert.equal(again.status, 409);
    });
    assert.deepEqual(
      audit.map((e) => [e.action, e.target]),
      [
        ['credential.grant_revoke', `credential-grant:${grant.id}`],
        ['credential.revoke', `credential:${personal.id}`],
      ],
    );
    assert.ok(!JSON.stringify(audit).includes(SECRET));
  });

  it('lets any operator revoke a service credential', async () => {
    const store = newStore();
    const { service } = await seed(store);
    await withServer(buildApp(store, []), async (base) => {
      const res = await call(`${base}/${service.id}/revoke`, 'bob', 'POST');
      assert.equal(res.status, 200);
    });
    assert.ok((await store.getCredential(service.id))?.revokedAt);
  });
});
