import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import type {
  CreateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import type { SecretVault } from '../../src/secrets/vault.js';

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
 * Live network-call to api.anthropic.com is shimmed by monkey-patching
 * `globalThis.fetch` for the duration of each test — keeps the suite
 * hermetic and CI-safe.
 */

// ─── In-memory test doubles ────────────────────────────────────────────────

class InMemoryUserStore implements Pick<UserStore, 'count' | 'create' | 'markLoginNow' | 'findByProviderUserId'> {
  rows: Array<UserRecord & { passwordHash: string | null }> = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const id = `mock-${this.rows.length + 1}`;
    const now = new Date();
    const row: UserRecord & { passwordHash: string | null } = {
      id,
      email: input.email,
      provider: input.provider,
      providerUserId: input.providerUserId,
      passwordHash: input.passwordHash ?? null,
      displayName: input.displayName ?? '',
      role: input.role ?? 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.rows.push(row);
    return { ...row, passwordHash: row.passwordHash ?? undefined };
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
}): Promise<Harness> {
  const store = new InMemoryUserStore();
  const vault = new InMemoryVault();
  const reactivateCalls: string[] = [];

  const registry = new ProviderRegistry();
  registry.replaceActive([
    new LocalPasswordProvider(store as unknown as UserStore),
  ]);

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
      setupAllowed: true,
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
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.anthropic.com')) {
      const status = opts.anthropicPingStatus ?? 200;
      return new Response('', { status });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
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
    assert.equal(h.store.rows[0].email, 'admin@example.com');

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
      assert.equal(w.entries['anthropic_api_key'], 'sk-ant-api03-validlooking-key');
    }

    // Reactivate fired once per consumer, in the same order
    assert.deepEqual(h.reactivateCalls.sort(), [
      '@omadia/orchestrator',
      '@omadia/orchestrator-extras',
      '@omadia/verifier',
    ]);
  });
});

describe('POST /api/v1/auth/setup — no-key path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({});
  });
  after(async () => {
    h.restoreFetch();
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

describe('POST /api/v1/auth/setup — anthropic-rejects-key path', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ anthropicPingStatus: 401 });
  });
  after(async () => {
    h.restoreFetch();
    await h.close();
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
