import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runAuthBootstrap } from '../../src/auth/bootstrap.js';
import { verifyPassword } from '../../src/auth/passwordHasher.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import type {
  CreateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';

/**
 * In-memory UserStore stub matching just the subset bootstrap calls into:
 * count() and create(). markLoginNow() etc. are never reached from the
 * bootstrap flow.
 */
class InMemoryUserStore implements Pick<UserStore, 'count' | 'create'> {
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
}

describe('runAuthBootstrap', () => {
  it('seeds first admin from env values when users-table empty', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store as unknown as UserStore,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: 'Admin',
      log: () => {},
    });
    assert.equal(result.seeded, true);
    assert.equal(result.setupRequired, false);
    assert.equal(result.totalUsers, 1);

    const created = store.rows[0];
    assert.equal(created.email, 'admin@example.com');
    assert.equal(created.provider, LOCAL_PROVIDER_ID);
    assert.equal(created.providerUserId, 'admin@example.com');
    assert.equal(created.displayName, 'Admin');
    assert.ok(
      await verifyPassword(created.passwordHash ?? '', 'pw-with-12-chars'),
      'expected stored hash to verify against the seed password',
    );
  });

  it('returns setupRequired=true when env values missing + table empty', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store as unknown as UserStore,
      bootstrapEmail: undefined,
      bootstrapPassword: undefined,
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, true);
    assert.equal(result.totalUsers, 0);
    assert.equal(store.rows.length, 0);
  });

  it('refuses too-short password (falls back to /setup)', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store as unknown as UserStore,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'short',
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, true);
    assert.equal(store.rows.length, 0);
  });

  it('refuses invalid email (falls back to /setup)', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store as unknown as UserStore,
      bootstrapEmail: 'not-an-email',
      bootstrapPassword: 'long-enough-pw',
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, true);
  });

  it('is idempotent: no-op when a user already exists', async () => {
    const store = new InMemoryUserStore();
    // Pre-existing user
    await store.create({
      email: 'existing@example.com',
      provider: LOCAL_PROVIDER_ID,
      providerUserId: 'existing@example.com',
      passwordHash: 'whatever',
    });
    const result = await runAuthBootstrap({
      userStore: store as unknown as UserStore,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, false);
    assert.equal(result.totalUsers, 1);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].email, 'existing@example.com');
  });
});
