import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { providerApiKeyVaultKey } from '@omadia/llm-provider';
import express from 'express';

import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import type {
  CreateFirstAdminInput,
  FirstAdminResult,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import {
  __clearVerificationCache,
  decodeVerifiedRecord,
  providerVerifiedAtVaultKey,
} from '../../src/platform/providerCredentialVerifier.js';
import type { SecretVault } from '../../src/secrets/vault.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * OB-61 — /api/v1/auth/setup integration test. Drives the route via
 * real Express + fetch and asserts:
 *
 *   1. Anthropic key (when supplied + validated) is seeded into all
 *      consumer plugin vaults via vault.setMany(agentId, …).
 *   2. installService.reactivate(agentId) is invoked once per consumer
 *      so the freshly-seeded key takes effect without a server restart.
 *   3. Setup-without-key still succeeds (admin user is created, no
 *      vault writes happen, no reactivate calls fire).
 *   4. Invalid key format (no "sk-ant-" prefix) → 400, no user created,
 *      no vault touched.
 *
 * Plus the first-user contract: `/providers` and `/setup` answer from ONE
 * predicate, the operator setup token is checked before anything else, and the
 * outcomes of the atomic `createFirstAdmin` map to 410 / 409. Concurrency
 * itself is proven against a real Postgres in
 * `setupRouteConcurrency.pg.test.ts` — an in-memory store has no concurrent
 * writers to lose a race to.
 *
 * Live network-call to api.anthropic.com is shimmed by monkey-patching
 * `globalThis.fetch` for the duration of each test — keeps the suite
 * hermetic and CI-safe.
 */

// ─── In-memory test doubles ────────────────────────────────────────────────

/** A stored row: the record plus the hash, which the store never hands out. */
interface StoredUser {
  user: UserRecord;
  passwordHash: string;
}

/**
 * The subset of `UserStore` the setup path reaches. Deliberately without
 * `create()`: the first admin may only come out of the atomic
 * `createFirstAdmin()`, so a handler that fell back to a plain INSERT would
 * crash here instead of passing.
 */
class InMemoryUserStore
  implements
    Pick<
      UserStore,
      'count' | 'createFirstAdmin' | 'markLoginNow' | 'findByProviderUserId' | 'findByEmailWithHash'
    >
{
  rows: StoredUser[] = [];
  countCalls = 0;
  firstAdminCalls = 0;
  /** When set, `createFirstAdmin` rejects with it (a database-side failure). */
  firstAdminError: unknown = undefined;
  /** Simulates a concurrent writer that committed after the fast path ran. */
  reportNotEmpty = false;

  async count(): Promise<number> {
    this.countCalls += 1;
    return this.rows.length;
  }

  async createFirstAdmin(input: CreateFirstAdminInput): Promise<FirstAdminResult> {
    this.firstAdminCalls += 1;
    if (this.firstAdminError !== undefined) throw this.firstAdminError;
    if (this.reportNotEmpty || this.rows.length > 0) {
      return { outcome: 'not_empty', totalUsers: Math.max(this.rows.length, 1) };
    }
    return { outcome: 'created', user: this.pushAdmin(input) };
  }

  /** An admin that was already there when the process started — the state of
   *  every restarted install. Bypasses `createFirstAdmin` and its counter. */
  seedExistingAdmin(email: string): void {
    this.pushAdmin({
      email,
      provider: 'local',
      providerUserId: email.toLowerCase(),
      displayName: email,
      passwordHash: 'argon2-hash-never-checked-here',
    });
  }

  private pushAdmin(
    input: Omit<CreateFirstAdminInput, 'via'>,
  ): UserRecord {
    const now = new Date();
    const user: UserRecord = {
      id: `mock-${String(this.rows.length + 1)}`,
      email: input.email,
      provider: input.provider,
      providerUserId: input.providerUserId,
      displayName: input.displayName,
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      sessionVersion: 0,
    };
    this.rows.push({ user, passwordHash: input.passwordHash });
    return user;
  }

  async markLoginNow(_id: string): Promise<void> {
    // Test stub — the route fire-and-forgets, return is irrelevant.
  }

  async findByProviderUserId(
    _provider: string,
    _providerUserId: string,
  ): Promise<UserRecord | null> {
    return null;
  }

  /** The sign-in device cookie reads the new admin's epoch (§10m). */
  async findByEmailWithHash(provider: string, email: string): Promise<UserRecord | null> {
    const row = this.rows.find(
      (r) => r.user.provider === provider && r.user.email.toLowerCase() === email.toLowerCase(),
    );
    return row ? { ...row.user, passwordHash: row.passwordHash } : null;
  }
}

class InMemoryVault implements SecretVault {
  writes: Array<{ agentId: string; entries: Record<string, string> }> = [];
  store = new Map<string, Map<string, string>>();

  async set(agentId: string, key: string, value: string): Promise<void> {
    this.setManyInternal(agentId, { [key]: value });
  }

  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    this.writes.push({ agentId, entries: { ...entries } });
    this.setManyInternal(agentId, entries);
  }

  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(agentId)?.get(key);
  }

  async listKeys(agentId: string): Promise<string[]> {
    return Array.from(this.store.get(agentId)?.keys() ?? []);
  }

  async purge(agentId: string): Promise<void> {
    this.store.delete(agentId);
  }

  async deleteKey(agentId: string, key: string): Promise<void> {
    this.store.get(agentId)?.delete(key);
  }

  private setManyInternal(agentId: string, entries: Record<string, string>): void {
    let bucket = this.store.get(agentId);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.store.set(agentId, bucket);
    }
    for (const [k, v] of Object.entries(entries)) {
      bucket.set(k, v);
    }
  }
}

// ─── Server harness ────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  store: InMemoryUserStore;
  vault: InMemoryVault;
  reactivateCalls: string[];
  restoreFetch: () => void;
}

async function startHarness(opts: {
  /** When provided, the stubbed fetch returns this status for the
   *  `/v1/models` ping — defaults to 200 (key accepted). */
  anthropicPingStatus?: number;
  /** Body for a NON-2xx ping. Load-bearing for 403: a bare 403 is a region or
   *  permission block, but a 403 whose body says `authentication_error` is a
   *  genuine rejection, and only the body tells the two apart. */
  anthropicPingBody?: string;
  /** Boot-time flag from `runAuthBootstrap`; defaults to true (wizard open). */
  setupAllowed?: boolean;
  /** Operator setup token; undefined = no token gate on this boot. */
  setupToken?: string;
  /** Register the local password provider (default true). */
  withLocalProvider?: boolean;
}): Promise<Harness> {
  const store = new InMemoryUserStore();
  const vault = new InMemoryVault();
  const reactivateCalls: string[] = [];

  const registry = new ProviderRegistry();
  registry.replaceActive(
    opts.withLocalProvider === false
      ? []
      : [new LocalPasswordProvider(store as unknown as UserStore)],
  );

  // Random 32-byte HMAC key — the test never re-validates the cookie so
  // the actual value doesn't matter; just needs to be the right shape.
  const signingKey = new Uint8Array(32);
  for (let i = 0; i < signingKey.length; i += 1) signingKey[i] = i + 1;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/auth',
    createAuthRouter({
      registry,
      userStore: store as unknown as UserStore,
      signingKey,
      publicBaseUrl: 'http://localhost',
      defaultReturnPath: '/',
      setupAllowed: opts.setupAllowed ?? true,
      ...(opts.setupToken !== undefined ? { setupToken: opts.setupToken } : {}),
      vault,
      reactivate: async (agentId: string) => {
        reactivateCalls.push(agentId);
      },
      anthropicKeyConsumers: [
        '@omadia/orchestrator',
        '@omadia/orchestrator-extras',
        '@omadia/verifier',
      ],
    }),
  );

  // Monkey-patch fetch so the validateAnthropicKey helper's external
  // call is intercepted. Falls through to any non-anthropic URLs (none
  // expected, but safe).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.anthropic.com')) {
      const status = opts.anthropicPingStatus ?? 200;
      // A 2xx only counts as `verified` when it carries a JSON model list — a
      // bare 200 is what a corporate proxy's block page looks like, and the
      // probe deliberately refuses to call that a working credential. The happy
      // path therefore has to answer like the real `models` endpoint does.
      if (status >= 200 && status < 300) {
        return new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(opts.anthropicPingBody ?? '', { status });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const server = await listenLoopback(app);
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    store,
    vault,
    reactivateCalls,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/setup (OB-61)', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness({ anthropicPingStatus: 200 });
  });

  after(async () => {
    h.restoreFetch();
    // The probe caches per provider id — clear it so a verdict cannot leak
    // into the next harness (or another test file).
    __clearVerificationCache();
    await h.close();
  });

  it('seeds anthropic_api_key into all consumer vaults and reactivates each', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-with-12-chars',
        anthropic_api_key: 'sk-ant-api03-validlooking-key',
      }),
    });
    assert.equal(res.status, 200, await res.text());

    // User created
    assert.equal(h.store.rows.length, 1);
    assert.equal(h.store.rows[0]?.user.email, 'admin@example.com');

    // Vault writes — exactly 3, one per consumer, all with the same key
    const writes = h.vault.writes;
    assert.equal(writes.length, 3, `expected 3 vault writes, got ${writes.length}`);
    const agentIds = writes.map((w) => w.agentId).sort();
    assert.deepEqual(agentIds, [
      '@omadia/orchestrator',
      '@omadia/orchestrator-extras',
      '@omadia/verifier',
    ]);
    for (const w of writes) {
      assert.equal(
        w.entries[providerApiKeyVaultKey('anthropic')],
        'sk-ant-api03-validlooking-key',
      );
    }

    // Reactivate fired once per consumer, in the same order
    assert.deepEqual(h.reactivateCalls.sort(), [
      '@omadia/orchestrator',
      '@omadia/orchestrator-extras',
      '@omadia/verifier',
    ]);
  });

  it('records that the ping succeeded (OM-08) instead of discarding the result', async () => {
    // The probe always ran here — but nothing wrote it down, so one line later
    // an accepted key was indistinguishable from a never-checked one, and the
    // providers page had to fall back to "some string is in the vault".
    const record = h.vault.writes[0]?.entries[
      providerVerifiedAtVaultKey('anthropic')
    ];
    assert.ok(record, 'a durable verification record must be written');
    assert.equal(
      decodeVerifiedRecord(record, 'sk-ant-api03-validlooking-key'),
      JSON.parse(record).at,
      'the record must be readable back for this exact key',
    );
    // …and NOT readable back for a different key.
    assert.equal(decodeVerifiedRecord(record, 'sk-ant-some-other-key'), undefined);
  });
});

describe('POST /api/v1/auth/setup — no-key path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({});
  });
  after(async () => {
    h.restoreFetch();
    // The probe caches per provider id — clear it so a verdict cannot leak
    // into the next harness (or another test file).
    __clearVerificationCache();
    await h.close();
  });

  it('succeeds without anthropic_api_key, no vault writes, no reactivate', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-with-12-chars',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(h.store.rows.length, 1);
    assert.equal(h.vault.writes.length, 0);
    assert.equal(h.reactivateCalls.length, 0);
  });
});

describe('POST /api/v1/auth/setup — invalid-key-format path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({});
  });
  after(async () => {
    h.restoreFetch();
    // The probe caches per provider id — clear it so a verdict cannot leak
    // into the next harness (or another test file).
    __clearVerificationCache();
    await h.close();
  });

  it('rejects keys without the sk-ant- prefix with 400 and creates no user', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-with-12-chars',
        anthropic_api_key: 'not-a-real-key',
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'auth.setup_invalid_anthropic_key');
    assert.equal(h.store.rows.length, 0);
    assert.equal(h.vault.writes.length, 0);
  });
});

describe('POST /api/v1/auth/setup — provider-outage path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ anthropicPingStatus: 503 });
  });
  after(async () => {
    h.restoreFetch();
    __clearVerificationCache();
    await h.close();
  });

  it('still accepts the key on a 5xx — an outage is not the operator\'s fault', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-with-12-chars',
        anthropic_api_key: 'sk-ant-api03-probably-fine',
      }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(h.store.rows.length, 1);
    assert.equal(h.vault.writes.length, 3, 'the key is still seeded');
    // …but it is NOT claimed as verified: no durable record was written.
    for (const w of h.vault.writes) {
      assert.equal(
        w.entries[providerVerifiedAtVaultKey('anthropic')],
        undefined,
        'an unproven key must not be recorded as verified',
      );
    }
  });
});

describe('POST /api/v1/auth/setup — anthropic-rejects-key path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ anthropicPingStatus: 401 });
  });
  after(async () => {
    h.restoreFetch();
    // The probe caches per provider id — clear it so a verdict cannot leak
    // into the next harness (or another test file).
    __clearVerificationCache();
    await h.close();
  });

  // A BARE 403 IS NOT A REJECTION. OpenAI answers 403 for "Country, region, or
  // territory not supported" and Anthropic for org-permission and region
  // blocks. This used to hard-block setup on any 403, which bricks the install
  // for an operator whose key is perfectly good but whose region is fenced —
  // and sends them off to rotate a credential that was never the problem.
  it('lets a bare 403 through — a region/permission block is not a bad key', async () => {
    const alt = await startHarness({ anthropicPingStatus: 403 });
    try {
      const res = await fetch(`${alt.baseUrl}/api/v1/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'pw-with-12-chars',
          anthropic_api_key: 'sk-ant-api03-region-blocked',
        }),
      });
      assert.equal(
        res.status,
        200,
        'an inconclusive probe must not block setup, same as the 5xx path',
      );
    } finally {
      alt.restoreFetch();
      __clearVerificationCache();
      await alt.close();
    }
  });

  it('still rejects a 403 that self-identifies as an authentication error', async () => {
    const alt = await startHarness({
      anthropicPingStatus: 403,
      anthropicPingBody: JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    });
    try {
      const res = await fetch(`${alt.baseUrl}/api/v1/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'pw-with-12-chars',
          anthropic_api_key: 'sk-ant-api03-forbidden',
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'auth.setup_anthropic_key_rejected');
    } finally {
      alt.restoreFetch();
      __clearVerificationCache();
      await alt.close();
    }
  });

  it('surfaces a 401 from the Anthropic ping as 400 setup_anthropic_key_rejected', async () => {
    const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-with-12-chars',
        anthropic_api_key: 'sk-ant-api03-revokedkey',
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'auth.setup_anthropic_key_rejected');
    assert.equal(h.store.rows.length, 0);
    assert.equal(h.vault.writes.length, 0);
  });
});

// ─── First-user contract ───────────────────────────────────────────────────

const VALID_SETUP = { email: 'admin@example.com', password: 'pw-with-12-chars' };

interface SetupReply {
  status: number;
  code: string | undefined;
  setCookie: string | null;
}

async function postSetup(
  h: Harness,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<SetupReply> {
  const res = await fetch(`${h.baseUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
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

async function getProviders(
  h: Harness,
): Promise<{ setup_required?: unknown; setup_token_required?: unknown }> {
  const res = await fetch(`${h.baseUrl}/api/v1/auth/providers`);
  assert.equal(res.status, 200);
  return (await res.json()) as { setup_required?: unknown; setup_token_required?: unknown };
}

async function stopHarness(h: Harness): Promise<void> {
  h.restoreFetch();
  __clearVerificationCache();
  await h.close();
}

describe('POST /api/v1/auth/setup — /providers and /setup answer from one predicate', () => {
  it('setupAllowed=false, table emptied since boot: discovery says no setup AND the handler refuses (410 auth.setup_disabled)', async () => {
    // The boot-time flag used to be read by /providers only. A users table
    // emptied after boot then advertised "no setup" while /setup still minted
    // an admin for whoever asked.
    const h = await startHarness({ setupAllowed: false });
    try {
      assert.equal((await getProviders(h)).setup_required, false);
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 410);
      assert.equal(res.code, 'auth.setup_disabled');
      assert.equal(res.setCookie, null);
      assert.equal(h.store.rows.length, 0);
      assert.equal(h.store.firstAdminCalls, 0, 'the handler must not reach the users-table lock');
    } finally {
      await stopHarness(h);
    }
  });

  it('setupAllowed=false with a user present: 410 auth.setup_locked, not auth.setup_disabled', async () => {
    // Every restart of an installed server boots with setupAllowed=false. While
    // a user exists the answer must stay "setup already completed": scripts
    // treat that code as done, the wizard sends the browser to /login on it,
    // and a restart would change nothing, so "restart the middleware" would be
    // wrong advice.
    const h = await startHarness({ setupAllowed: false });
    try {
      h.store.seedExistingAdmin('existing-admin@example.com');
      assert.equal((await getProviders(h)).setup_required, false);
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 410);
      assert.equal(res.code, 'auth.setup_locked');
      assert.equal(res.setCookie, null);
      assert.equal(h.store.rows.length, 1);
      assert.equal(h.store.firstAdminCalls, 0, 'the handler must not reach the users-table lock');
    } finally {
      await stopHarness(h);
    }
  });

  it('a user already exists: both report locked, and the fast path answers before the lock', async () => {
    const h = await startHarness({});
    try {
      assert.equal((await postSetup(h, VALID_SETUP)).status, 200);
      assert.equal((await getProviders(h)).setup_required, false);

      const again = await postSetup(h, { ...VALID_SETUP, email: 'second@example.com' });
      assert.equal(again.status, 410);
      assert.equal(again.code, 'auth.setup_locked');
      assert.equal(h.store.firstAdminCalls, 1, 'only the first request reached createFirstAdmin');
      assert.equal(h.store.rows.length, 1);
    } finally {
      await stopHarness(h);
    }
  });

  it('no local provider: discovery says no setup and the handler answers 410 auth.setup_no_local_provider', async () => {
    const h = await startHarness({ withLocalProvider: false });
    try {
      assert.equal((await getProviders(h)).setup_required, false);
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 410);
      assert.equal(res.code, 'auth.setup_no_local_provider');
      assert.equal(h.store.rows.length, 0);
    } finally {
      await stopHarness(h);
    }
  });
});

describe('POST /api/v1/auth/setup — operator setup token', () => {
  const TOKEN = 'test-token-0123456789abcdef';
  let h: Harness;

  before(async () => {
    h = await startHarness({ setupToken: TOKEN });
  });
  after(async () => {
    await stopHarness(h);
  });

  it('/providers advertises that the wizard needs a token', async () => {
    const providers = await getProviders(h);
    assert.equal(providers.setup_required, true);
    assert.equal(providers.setup_token_required, true);
  });

  it('a missing token is refused with 403 before the store is touched or the body is read', async () => {
    // Invalid email on purpose: a 400 here would mean the body was validated
    // (and, for a valid body, argon2 run) for a caller the operator never
    // authorised.
    const countBefore = h.store.countCalls;
    const res = await postSetup(h, { email: 'not-an-email', password: 'x' });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'auth.setup_token_invalid');
    assert.equal(h.store.countCalls, countBefore, 'the token gate runs before the fast path');
    assert.equal(h.store.firstAdminCalls, 0, 'an unauthorised caller never takes the lock');
    assert.equal(h.store.rows.length, 0);
  });

  it('a wrong, truncated or non-string token is refused with 403', async () => {
    const countBefore = h.store.countCalls;
    for (const setup_token of [
      'test-token-0123456789abcdeX',
      TOKEN.slice(0, -1),
      `${TOKEN}x`,
      '',
      42,
      null,
      [TOKEN],
    ]) {
      const res = await postSetup(h, { ...VALID_SETUP, setup_token });
      assert.equal(res.status, 403, `token ${JSON.stringify(setup_token)} must be refused`);
      assert.equal(res.code, 'auth.setup_token_invalid');
    }
    assert.equal(h.store.countCalls, countBefore);
    assert.equal(h.store.firstAdminCalls, 0);
    assert.equal(h.store.rows.length, 0);
  });

  it('the token travels in the body only — a header copy is not a second credential', async () => {
    const res = await postSetup(h, VALID_SETUP, { 'x-setup-token': TOKEN });
    assert.equal(res.status, 403);
    assert.equal(h.store.rows.length, 0);
  });

  it('the right token creates the first admin and signs them in', async () => {
    const res = await postSetup(h, { ...VALID_SETUP, setup_token: TOKEN });
    assert.equal(res.status, 200);
    assert.ok(res.setCookie, 'the new admin gets a session');
    assert.equal(h.store.rows.length, 1);
    assert.equal(h.store.rows[0]?.user.email, 'admin@example.com');
  });

  it('after setup, the right token still cannot create a second admin', async () => {
    const res = await postSetup(h, {
      ...VALID_SETUP,
      email: 'second@example.com',
      setup_token: TOKEN,
    });
    assert.equal(res.status, 410);
    assert.equal(res.code, 'auth.setup_locked');
    assert.equal(h.store.rows.length, 1);
  });
});

describe('POST /api/v1/auth/setup — boot without a token gate', () => {
  it('/providers reports setup_token_required: false', async () => {
    const h = await startHarness({});
    try {
      const providers = await getProviders(h);
      assert.equal(providers.setup_required, true);
      assert.equal(providers.setup_token_required, false);
    } finally {
      await stopHarness(h);
    }
  });
});

describe('POST /api/v1/auth/setup — outcomes of the atomic create', () => {
  it('a writer that won between the fast path and the lock → 410 auth.setup_locked, no session', async () => {
    const h = await startHarness({});
    h.store.reportNotEmpty = true;
    try {
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 410);
      assert.equal(res.code, 'auth.setup_locked');
      assert.equal(res.setCookie, null);
      assert.equal(h.store.firstAdminCalls, 1);
    } finally {
      await stopHarness(h);
    }
  });

  it('lock_timeout (55P03) → 409 auth.setup_in_progress, no session', async () => {
    const h = await startHarness({});
    h.store.firstAdminError = Object.assign(
      new Error('canceling statement due to lock timeout'),
      { code: '55P03' },
    );
    try {
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 409);
      assert.equal(res.code, 'auth.setup_in_progress');
      assert.equal(res.setCookie, null);
    } finally {
      await stopHarness(h);
    }
  });

  it('any other database failure is not reported as contention', async () => {
    const h = await startHarness({});
    h.store.firstAdminError = Object.assign(new Error('connection terminated'), {
      code: '08006',
    });
    try {
      const res = await postSetup(h, VALID_SETUP);
      assert.equal(res.status, 500);
      assert.equal(res.setCookie, null);
    } finally {
      await stopHarness(h);
    }
  });
});

describe('POST /api/v1/auth/setup — the shared password policy', () => {
  // UTF-16 code units, the unit sign-in counts in: '\u{1F511}' is two.
  const longest = 'p'.repeat(1022) + '\u{1F511}';

  it('accepts a password of exactly 1024 code units, and it signs in', async () => {
    const h = await startHarness({});
    try {
      assert.equal(longest.length, 1024);
      const res = await postSetup(h, { ...VALID_SETUP, password: longest });
      assert.equal(res.status, 200);
      assert.equal(h.store.rows.length, 1);

      const login = await fetch(`${h.baseUrl}/api/v1/auth/login/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: VALID_SETUP.email, password: longest }),
      });
      assert.equal(login.status, 200, 'what setup stored, sign-in accepts');
    } finally {
      await stopHarness(h);
    }
  });

  it('refuses 1025 code units with 400 auth.setup_password_too_long and creates no admin', async () => {
    const h = await startHarness({});
    try {
      const res = await postSetup(h, { ...VALID_SETUP, password: `${longest}p` });
      assert.equal(res.status, 400);
      assert.equal(res.code, 'auth.setup_password_too_long');
      assert.equal(res.setCookie, null);
      assert.equal(h.store.firstAdminCalls, 0, 'refused before the create');
      assert.equal(h.store.rows.length, 0);
    } finally {
      await stopHarness(h);
    }
  });
});
