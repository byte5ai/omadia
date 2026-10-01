/**
 * The sign-in limiter's two account identities against a real Postgres
 * (docs/security-architecture.md §10f, `src/auth/loginAccount.ts`).
 *
 * The users table matches `LOWER(email) = LOWER($input)` under the database's
 * collation, and the shipped databases (libc en_US.UTF-8, the builtin
 * C.UTF-8 provider) fold a capital dotted İ to a plain i, where JavaScript's
 * toLowerCase() keeps a combining dot. This suite runs the real UserStore,
 * LocalPasswordProvider and auth router over the auth migrations:
 *
 *  - every pair of spellings this database's LOWER() merges has one limiter
 *    bucket key;
 *  - the device key of an address finds the row the address itself finds;
 *  - spellings of one account share one guessing budget;
 *  - signing in to one account under another spelling mints a device cookie
 *    for that account, never for the row the typed spelling would name.
 *
 * Schema from the actual auth migrations, each applied twice, in a private
 * `search_path`-pinned schema. Skips loudly when no test Postgres is set.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { Pool } from 'pg';

import { loginAccountKey, loginDeviceAccountName } from '../../src/auth/loginAccount.js';
import { LOGIN_DEVICE_COOKIE } from '../../src/auth/loginDeviceCookie.js';
import { createLoginDevices, usersTableEpochs } from '../../src/auth/loginDevices.js';
import { createLoginRateLimiter } from '../../src/auth/loginRateLimiter.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import {
  LOCAL_PROVIDER_ID,
  LocalPasswordProvider,
} from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { UserStore } from '../../src/auth/userStore.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { invoke, type InvokeResult } from '../_helpers/httpInvoke.js';
import { probePgTest } from '../_helpers/pgTestDb.js';
import { accountSpellings } from './accountSpellings.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'loginAccountFold',
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

const SCHEMA = `login_account_fold_${String(process.pid)}`;
const SIGNING_KEY = new TextEncoder().encode('login-account-fold-pg-test-key-'.repeat(2));
/** Every browser behind the web-ui proxy reaches the middleware from here. */
const PROXY = '10.0.0.5';
const FREE = 5;
/** Never verified: rows that only need to exist. */
const SYNTHETIC_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c3ludGhldGlj';

function deviceCookieOf(res: InvokeResult): string {
  const raw = res.headers['set-cookie'];
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const cookie = all.find((c) => c.startsWith(`${LOGIN_DEVICE_COOKIE}=`));
  assert.ok(cookie, 'the sign-in set a device cookie');
  return cookie.split(';')[0] ?? '';
}

describe('sign-in account identities against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: UserStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${SCHEMA},public` });
    for (const file of ['0001_users.sql', '0002_admin_audit.sql']) {
      const sql = await readFile(resolve(AUTH_MIGRATIONS_DIR, file), 'utf8');
      // Twice: the schema CI gate double-applies every file in the series.
      await pool.query(sql);
      await pool.query(sql);
    }
    store = new UserStore(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, admin_audit, platform_settings');
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  /** This database's LOWER() of each spelling. */
  async function lowered(spellings: readonly string[]): Promise<Map<string, string>> {
    const res = await pool.query<{ s: string; l: string }>(
      'SELECT s, LOWER(s) AS l FROM unnest($1::text[]) AS s',
      [spellings],
    );
    return new Map(res.rows.map((r) => [r.s, r.l]));
  }

  async function addUser(email: string, passwordHash = SYNTHETIC_HASH): Promise<string> {
    const user = await store.create({
      email,
      provider: LOCAL_PROVIDER_ID,
      providerUserId: email.toLowerCase(),
      passwordHash,
      displayName: email,
    });
    return user.id;
  }

  /** The real auth router over the real store, with a fresh limiter. */
  function authApp(): Express {
    const registry = new ProviderRegistry();
    registry.replaceActive([new LocalPasswordProvider(store)]);
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry,
        userStore: store,
        signingKey: SIGNING_KEY,
        publicBaseUrl: 'https://omadia.example',
        defaultReturnPath: '/',
        setupAllowed: false,
        loginLimiter: {
          limiter: createLoginRateLimiter(),
          clientAddress: { kind: 'socket' },
          devices: createLoginDevices({ signingKey: SIGNING_KEY, epochs: usersTableEpochs(store) }),
        },
      }),
    );
    return app;
  }

  function login(app: Express, email: string, password: string, cookie?: string): Promise<InvokeResult> {
    return invoke(app, 'POST', `/api/v1/auth/login/${LOCAL_PROVIDER_ID}`, {
      json: { email, password },
      remoteAddress: PROXY,
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  it('every pair of spellings this LOWER() treats as one account has one bucket key', async () => {
    const spellings = accountSpellings().map((s) => s.trim());
    const lower = await lowered(spellings);
    let merged = 0;
    for (const a of spellings) {
      for (const b of spellings) {
        if (a === b || lower.get(a) !== lower.get(b)) continue;
        merged += 1;
        assert.equal(loginAccountKey('local', a), loginAccountKey('local', b), `${a} vs ${b}`);
      }
    }
    assert.ok(merged > 0, 'the corpus holds spellings LOWER() merges');
  });

  it('the device key of an address finds the row the address itself finds', async () => {
    const stored = [
      'Admin@Example.com',
      'iiii@example.com',
      'i̇iii@example.com',
      'Élise@example.com',
      'ΑΣ@example.com',
    ];
    for (const email of stored) await addUser(email);
    const typed = [
      ...stored.flatMap((s) => [s, s.toUpperCase(), s.toLowerCase(), ` ${s} `]),
      'İiii@example.com',
      'ADMİN@EXAMPLE.COM',
    ];
    for (const address of typed) {
      const byAddress = await store.findByEmailWithHash(LOCAL_PROVIDER_ID, address.trim());
      const name = loginDeviceAccountName(address);
      assert.ok(name);
      const byName = await store.findByEmailWithHash(LOCAL_PROVIDER_ID, name);
      assert.equal(byName?.id ?? null, byAddress?.id ?? null, JSON.stringify(address));
    }
  });

  it('spellings of one account share one guessing budget through the router', async () => {
    const password = 'a synthetic passphrase for the admin';
    await addUser('admin@example.com', await hashPassword(password));
    const spellings = [
      'admin@example.com',
      'ADMİN@EXAMPLE.COM',
      'admİn@example.com',
      'Admİn@Example.com',
      'ADMIN@example.com',
    ];
    const lower = await lowered(spellings);
    assert.ok(
      spellings.every((s) => lower.get(s) === 'admin@example.com'),
      'precondition: LOWER() folds the capital dotted İ to i (libc en_US.UTF-8, builtin C.UTF-8)',
    );

    const app = authApp();
    for (const email of spellings) {
      assert.equal((await login(app, email, 'not the password')).status, 401, email);
    }
    for (const email of spellings) {
      assert.equal((await login(app, email, password)).status, 429, email);
    }
  });

  it('a device cookie belongs to the row that signed in, not to the row its spelling names', async () => {
    const A = 'iiii@example.com';
    const B = 'i̇iii@example.com';
    const ALIAS = 'İiii@example.com';
    const passwordA = 'a synthetic passphrase for account a';
    const idA = await addUser(A, await hashPassword(passwordA));
    const idB = await addUser(B, await hashPassword('a synthetic passphrase for account b'));
    assert.equal((await store.findByEmailWithHash(LOCAL_PROVIDER_ID, ALIAS))?.id, idA, 'precondition: the alias is A');
    assert.equal((await store.findByEmailWithHash(LOCAL_PROVIDER_ID, B))?.id, idB);

    const app = authApp();
    const signedIn = await login(app, ALIAS, passwordA);
    assert.equal(signedIn.status, 200);
    const device = deviceCookieOf(signedIn);

    for (let i = 0; i < FREE; i += 1) await login(app, B, 'not the password');
    assert.equal((await login(app, B, 'not the password')).status, 429);
    assert.equal((await login(app, B, 'not the password', device)).status, 429, 'no known browser of B');
    assert.equal((await login(app, A, passwordA, device)).status, 200, 'a known browser of A');
  });
});
