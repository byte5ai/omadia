import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express from 'express';

import type { AdminAuditLog, AuditEntryInput } from '../../src/auth/adminAuditLog.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { createRequireAuth, SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { mountAdminTokenSurface } from '../../src/routes/adminTokenMount.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * The ADMIN_TOKEN break-glass surface must be reachable with the bearer token
 * alone, in the production composition: mounted before the real `/api`
 * session gate with the production public-path list. Mounted after it, a
 * bearer request got the gate's `auth.missing` 401 before the token was ever
 * compared — the bug this pins.
 */

const TOKEN = 'admin-token-0123456789abcdef';
const KEY = new TextEncoder().encode('A'.repeat(64));

interface Harness {
  server: Server;
  base: string;
  audited: AuditEntryInput[];
  logs: string[];
  writes: string[];
  auditFails: { value: boolean };
}

async function startHarness(token: string | undefined): Promise<Harness & { mounted: boolean }> {
  const audited: AuditEntryInput[] = [];
  const logs: string[] = [];
  const writes: string[] = [];
  const auditFails = { value: false };
  const audit = {
    record: async (entry: AuditEntryInput): Promise<void> => {
      if (auditFails.value) throw new Error('db down');
      audited.push(entry);
    },
  } as unknown as AdminAuditLog;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const mounted = mountAdminTokenSurface(app, {
    token,
    store: {
      writeFile: async (path: string) => {
        writes.push(path);
      },
    } as never,
    audit: () => audit,
    log: (line) => logs.push(line),
    runTraceStats: () => {
      throw new Error('registry exploded');
    },
  });
  const requireAuth = createRequireAuth({
    signingKey: KEY,
    whitelist: new EmailWhitelist(''),
    publicPaths: publicPaths(),
  });
  app.use('/api', requireAuth, express.Router());
  // The session-authenticated neighbour on the same prefix (graphRouterMounts).
  app.use('/api/admin/domains', requireAuth, (_req, res) => {
    res.json({ domains: true });
  });
  app.use('/api/v1/admin/users', (_req, res) => {
    res.json({ users: true });
  });
  // Stands in for the terminal JSON error handler (#1410).
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });

  const server = await listenLoopback(app);
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { server, base, audited, logs, writes, auditFails, mounted };
}

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

describe('ADMIN_TOKEN surface before the /api session gate', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness(TOKEN);
  });
  after(() => {
    h.server.close();
  });
  beforeEach(() => {
    h.audited.length = 0;
    h.logs.length = 0;
    h.writes.length = 0;
    h.auditFails.value = false;
  });

  it('serves a bearer-only request and audits it first', async () => {
    const res = await fetch(`${h.base}/api/admin/security/screening`, { headers: bearer(TOKEN) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.healthy, 'boolean');
    assert.deepEqual(h.audited, [
      {
        actor: { email: 'system:admin-token' },
        action: 'admin_token.use',
        target: 'admin-api:GET /api/admin/security/screening',
      },
    ]);
  });

  it('refuses a wrong bearer token with 401: logged each time, one refusal row per minute', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${h.base}/api/admin/security/screening`, { headers: bearer('nope') });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
    assert.deepEqual(h.audited, [
      {
        actor: { email: 'system:admin-token' },
        action: 'admin_token.refused',
        target: 'admin-api:GET /api/admin/security/screening',
      },
    ]);
    assert.equal(h.logs.length, 3);
    for (const line of h.logs) assert.doesNotMatch(line, /nope/, 'the supplied token is never logged');
  });

  it('accepts the scheme case-insensitively', async () => {
    const res = await fetch(`${h.base}/api/admin/security/screening`, {
      headers: { authorization: `bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  it('hands a failing admin route to the error handler (500), not a 404', async () => {
    const res = await fetch(`${h.base}/api/admin/run-trace`, { headers: bearer(TOKEN) });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal' });
  });

  it('leaves a request without a bearer to the session gate', async () => {
    const res = await fetch(`${h.base}/api/admin/security/screening`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'auth.missing');
    assert.equal(h.audited.length, 0);
  });

  it('does not open the session-gated /api/admin/domains neighbour to the token', async () => {
    const res = await fetch(`${h.base}/api/admin/domains`, { headers: bearer(TOKEN) });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  it('keeps /api/admin/domains working for a session caller', async () => {
    const cookie = await signSession(
      { sub: 'op@example.com', email: 'op@example.com', display_name: 'Op', provider: 'local', role: 'admin' },
      KEY,
    );
    const res = await fetch(`${h.base}/api/admin/domains`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { domains: true });
  });

  it('does not claim other admin prefixes: /api/v1/admin/* still meets the gate', async () => {
    const res = await fetch(`${h.base}/api/v1/admin/users`, { headers: bearer(TOKEN) });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'auth.missing');
  });

  it('refuses with 503 and does not act when the audit row cannot be written', async () => {
    h.auditFails.value = true;
    const res = await fetch(`${h.base}/api/admin/memory`, {
      method: 'PUT',
      headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/memories/x.md', content: 'x' }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(h.writes, [], 'the write must not run unrecorded');
  });
});

describe('ADMIN_TOKEN unset or blank', () => {
  for (const token of [undefined, '', '   ']) {
    it(`does not mount for ${JSON.stringify(token)}; a bearer meets the gate`, async () => {
      const h = await startHarness(token);
      try {
        assert.equal(h.mounted, false);
        const res = await fetch(`${h.base}/api/admin/security/screening`, { headers: bearer('   ') });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code?: string }).code, 'auth.missing');
      } finally {
        h.server.close();
      }
    });
  }
});

describe('index.ts wiring', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts'),
    'utf8',
  );

  it('mounts the token surface before the blanket /api session gate', () => {
    const mount = src.indexOf('mountAdminTokenSurface(app,');
    const gate = src.indexOf("app.use(\n    '/api',\n    requireAuth,");
    assert.notEqual(mount, -1, 'mountAdminTokenSurface call not found');
    assert.notEqual(gate, -1, '/api requireAuth mount not found');
    assert.ok(mount < gate, 'the token surface must be mounted before the session gate');
  });

  it('mounts the admin router nowhere else', () => {
    assert.doesNotMatch(src, /createAdminRouter\(/);
  });
});
