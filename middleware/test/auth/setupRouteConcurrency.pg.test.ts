/**
 * First-user setup under real concurrency, against a real Postgres.
 *
 * `setupRoute.test.ts` pins the handler's contract with an in-memory store,
 * which by construction has no concurrent writers — it cannot show that two
 * requests racing through `POST /api/v1/auth/setup` produce one admin. This
 * suite drives the real router, the real `UserStore` and the real `users`
 * table with N simultaneous requests. Every request passes the cheap
 * "table still empty?" check before any of them has committed (the argon2
 * hash sits between that check and the write), which is exactly the window a
 * count-then-INSERT handler loses: distinct emails all insert and each winner
 * gets an admin session; the same email trips the unique index and surfaces
 * as an unhandled 500.
 *
 * The schema comes from the actual auth migrations (0001 users, 0002 audit +
 * platform settings), each applied twice like every other `*.pg.test.ts`, in
 * a private schema pinned through `search_path`. Skips loudly when no test
 * Postgres is configured.
 *
 * Pool sizing: every in-flight request holds one client inside the first-admin
 * transaction while the fast-path `count()` and the fire-and-forget
 * `markLoginNow` of the others need clients too, so the pool is sized above N.
 * A pool of 2 would serialise the requests in the pool queue and let a broken
 * handler pass for the wrong reason.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Pool } from 'pg';

import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
} from '../../src/auth/loginRateLimiter.js';
import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { UserStore } from '../../src/auth/userStore.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';
import { probePgTest } from '../_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'setupRouteConcurrency',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const AUTH_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'auth',
  'migrations',
);

const SCHEMA = `setup_route_conc_${String(process.pid)}`;

/** Parallel setup requests per test. */
const N = 8;

interface SetupReply {
  status: number;
  code: string | undefined;
  setCookie: string | null;
}

describe('POST /api/v1/auth/setup under concurrency (real Postgres)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let baseUrl = '';
  let close: () => Promise<void> = async () => undefined;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    pool = new Pool({
      connectionString: PG_URL,
      max: N + 4,
      options: `-c search_path=${SCHEMA},public`,
    });
    for (const file of ['0001_users.sql', '0002_admin_audit.sql']) {
      const sql = await readFile(resolve(AUTH_MIGRATIONS_DIR, file), 'utf8');
      // Twice: the schema CI gate double-applies every file in the series.
      await pool.query(sql);
      await pool.query(sql);
    }

    const userStore = new UserStore(pool);
    const registry = new ProviderRegistry();
    registry.replaceActive([new LocalPasswordProvider(userStore)]);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry,
        userStore,
        signingKey: new Uint8Array(32).fill(7),
        publicBaseUrl: 'http://localhost',
        defaultReturnPath: '/',
        setupAllowed: true,
        // The wizard's hash takes a slot of the sign-in limiter's argon2
        // capacity (§10m). Give it room for all N, so every request reaches
        // the race this suite is about instead of an early 503 auth.busy.
        loginLimiter: {
          limiter: createLoginRateLimiter({
            ...DEFAULT_LOGIN_LIMITER_CONFIG,
            globalMaxInFlight: N + DEFAULT_LOGIN_LIMITER_CONFIG.globalDeviceReserveInFlight,
          }),
          clientAddress: { kind: 'socket' },
        },
      }),
    );
    const server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    close = () =>
      new Promise<void>((done, fail) => {
        server.close((err) => (err ? fail(err) : done()));
      });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, admin_audit, platform_settings');
  });

  after(async () => {
    await close();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  async function postSetup(email: string): Promise<SetupReply> {
    const res = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'pw-with-12-chars' }),
    });
    const text = await res.text();
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      code = typeof parsed.code === 'string' ? parsed.code : undefined;
    } catch {
      code = undefined;
    }
    return { status: res.status, code, setCookie: res.headers.get('set-cookie') };
  }

  async function userCount(): Promise<number> {
    const res = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM users');
    return Number(res.rows[0]?.n ?? '0');
  }

  it(`${String(N)} parallel requests with distinct emails create exactly one admin`, async () => {
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) => postSetup(`admin${String(i)}@example.com`)),
    );

    const winners = replies.filter((r) => r.status === 200);
    const losers = replies.filter((r) => r.status !== 200);
    assert.equal(
      winners.length,
      1,
      `exactly one request may create the first admin, got statuses ${JSON.stringify(replies.map((r) => r.status))}`,
    );
    assert.ok(winners[0]?.setCookie, 'the winner is signed in');
    for (const loser of losers) {
      assert.equal(loser.status, 410);
      assert.equal(loser.code, 'auth.setup_locked');
      assert.equal(loser.setCookie, null, 'a request that created nothing gets no session');
    }
    assert.equal(await userCount(), 1);
  });

  it(`${String(N)} parallel requests with the same email: one admin, never a 500`, async () => {
    const replies = await Promise.all(
      Array.from({ length: N }, () => postSetup('same@example.com')),
    );

    const statuses = replies.map((r) => r.status).sort((a, b) => a - b);
    assert.ok(
      !statuses.includes(500),
      `a duplicate-email race must not surface as a 500, got ${JSON.stringify(statuses)}`,
    );
    assert.deepEqual(statuses, [200, ...Array.from({ length: N - 1 }, () => 410)]);
    assert.equal(await userCount(), 1);
  });
});
