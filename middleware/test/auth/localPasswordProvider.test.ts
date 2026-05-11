import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hashPassword } from '../../src/auth/passwordHasher.js';
import {
  LOCAL_PROVIDER_ID,
  LocalPasswordProvider,
} from '../../src/auth/providers/LocalPasswordProvider.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';

/**
 * In-memory UserStore stub that satisfies the subset of methods the
 * LocalPasswordProvider actually calls. Keeps the test entirely
 * Postgres-free + deterministic.
 */
class InMemoryUserStore implements Pick<
  UserStore,
  'findByEmailWithHash' | 'markLoginNow'
> {
  private rows = new Map<string, UserRecord & { passwordHash: string | null }>();

  async addLocalUser(opts: {
    email: string;
    plainPassword: string;
    status?: 'active' | 'disabled';
    displayName?: string;
  }): Promise<void> {
    const hash = await hashPassword(opts.plainPassword);
    const id = `mock-${this.rows.size + 1}`;
    const now = new Date();
    this.rows.set(opts.email.toLowerCase(), {
      id,
      email: opts.email,
      provider: LOCAL_PROVIDER_ID,
      providerUserId: opts.email.toLowerCase(),
      passwordHash: hash,
      displayName: opts.displayName ?? opts.email,
      role: 'admin',
      status: opts.status ?? 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    });
  }

  async findByEmailWithHash(
    provider: string,
    email: string,
  ): Promise<UserRecord | null> {
    if (provider !== LOCAL_PROVIDER_ID) return null;
    const row = this.rows.get(email.toLowerCase());
    if (!row) return null;
    return row.passwordHash != null
      ? { ...row, passwordHash: row.passwordHash }
      : { ...row, passwordHash: undefined };
  }

  async markLoginNow(_id: string): Promise<void> {
    /* no-op — tested via observable side-effects elsewhere */
  }
}

function provider(store: InMemoryUserStore): LocalPasswordProvider {
  return new LocalPasswordProvider(store as unknown as UserStore);
}

describe('LocalPasswordProvider.verify', () => {
  it('rejects malformed bodies with invalid_credentials', async () => {
    const p = provider(new InMemoryUserStore());
    const r1 = await p.verify(undefined);
    assert.equal(r1.outcome, 'error');
    if (r1.outcome === 'error') {
      assert.equal(r1.code, 'invalid_credentials');
    }
    const r2 = await p.verify({ email: 'x', password: '' });
    assert.equal(r2.outcome, 'error');
  });

  it('rejects unknown user with invalid_credentials (not unknown_user)', async () => {
    const store = new InMemoryUserStore();
    const r = await provider(store).verify({
      email: 'nobody@example.com',
      password: 'whatever',
    });
    assert.equal(r.outcome, 'error');
    if (r.outcome === 'error') {
      assert.equal(r.code, 'invalid_credentials');
    }
  });

  it('rejects wrong password with invalid_credentials', async () => {
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'admin@example.com',
      plainPassword: 'correct-pass-1',
    });
    const r = await provider(store).verify({
      email: 'admin@example.com',
      password: 'wrong-pass',
    });
    assert.equal(r.outcome, 'error');
    if (r.outcome === 'error') {
      assert.equal(r.code, 'invalid_credentials');
    }
  });

  it('rejects disabled user with user_disabled', async () => {
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'disabled@example.com',
      plainPassword: 'pw-12345678',
      status: 'disabled',
    });
    const r = await provider(store).verify({
      email: 'disabled@example.com',
      password: 'pw-12345678',
    });
    assert.equal(r.outcome, 'error');
    if (r.outcome === 'error') {
      assert.equal(r.code, 'user_disabled');
    }
  });

  it('returns success on correct credentials with normalised email', async () => {
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'Admin@Example.com',
      plainPassword: 'pw-12345678',
      displayName: 'Admin User',
    });
    const r = await provider(store).verify({
      email: 'admin@example.com', // mixed → lower; lookup is case-insensitive
      password: 'pw-12345678',
    });
    assert.equal(r.outcome, 'success');
    if (r.outcome === 'success') {
      assert.equal(r.email, 'Admin@Example.com');
      assert.equal(r.providerUserId, 'admin@example.com');
      assert.equal(r.displayName, 'Admin User');
    }
  });
});
