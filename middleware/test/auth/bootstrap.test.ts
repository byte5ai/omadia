import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runAuthBootstrap } from '../../src/auth/bootstrap.js';
import { verifyPassword } from '../../src/auth/passwordHasher.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import type {
  CreateFirstAdminInput,
  FirstAdminResult,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';

/** A stored row: the record plus the hash the store never hands out. */
interface StoredUser {
  user: UserRecord;
  passwordHash: string;
  via: CreateFirstAdminInput['via'];
}

/**
 * In-memory UserStore stub matching just the subset bootstrap calls into:
 * count() and createFirstAdmin(). There is deliberately no create(): the env
 * seed must go through the atomic first-admin path, so a regression to a
 * plain INSERT crashes here instead of passing.
 */
class InMemoryUserStore implements Pick<UserStore, 'count' | 'createFirstAdmin'> {
  rows: StoredUser[] = [];
  firstAdminCalls = 0;
  /** Simulates another replica committing its seed between our count() and our insert. */
  otherReplicaWins = false;

  async count(): Promise<number> {
    return this.rows.length;
  }

  async createFirstAdmin(input: CreateFirstAdminInput): Promise<FirstAdminResult> {
    this.firstAdminCalls += 1;
    if (this.otherReplicaWins) this.seed('other-replica@example.com', 'env_seed');
    if (this.rows.length > 0) return { outcome: 'not_empty', totalUsers: this.rows.length };
    const user = this.seed(input.email, input.via, input);
    return { outcome: 'created', user };
  }

  seed(
    email: string,
    via: CreateFirstAdminInput['via'],
    input?: CreateFirstAdminInput,
  ): UserRecord {
    const now = new Date();
    const user: UserRecord = {
      id: `mock-${String(this.rows.length + 1)}`,
      email,
      provider: input?.provider ?? LOCAL_PROVIDER_ID,
      providerUserId: input?.providerUserId ?? email.toLowerCase(),
      displayName: input?.displayName ?? email,
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      sessionVersion: 0,
    };
    this.rows.push({ user, passwordHash: input?.passwordHash ?? 'whatever', via });
    return user;
  }
}

describe('runAuthBootstrap', () => {
  it('seeds first admin from env values when users-table empty', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: 'Admin',
      log: () => {},
    });
    assert.equal(result.seeded, true);
    assert.equal(result.setupRequired, false);
    assert.equal(result.totalUsers, 1);

    const created = store.rows[0];
    assert.ok(created, 'a row was seeded');
    assert.equal(created.user.email, 'admin@example.com');
    assert.equal(created.user.provider, LOCAL_PROVIDER_ID);
    assert.equal(created.user.providerUserId, 'admin@example.com');
    assert.equal(created.user.displayName, 'Admin');
    assert.equal(created.via, 'env_seed', 'the audit row names the env seed');
    assert.ok(
      await verifyPassword(created.passwordHash, 'pw-with-12-chars'),
      'expected stored hash to verify against the seed password',
    );
  });

  it('seeds through the atomic first-admin path, once', async () => {
    const store = new InMemoryUserStore();
    await runAuthBootstrap({
      userStore: store,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(store.firstAdminCalls, 1);
  });

  it('another replica seeding first is a logged skip, not a crash', async () => {
    // Two replicas booting together both see an empty table. Before the
    // atomic path the loser's INSERT died on the unique index and took the
    // boot down; now it reports not_empty and this replica simply skips.
    const store = new InMemoryUserStore();
    store.otherReplicaWins = true;
    const logs: string[] = [];
    const result = await runAuthBootstrap({
      userStore: store,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: undefined,
      log: (m) => logs.push(m),
    });
    assert.deepEqual(result, { seeded: false, setupRequired: false, totalUsers: 1 });
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.user.email, 'other-replica@example.com');
    assert.ok(
      logs.some((l) => /populated by another replica/.test(l)),
      `expected a skip log line, got ${JSON.stringify(logs)}`,
    );
  });

  it('returns setupRequired=true when env values missing + table empty', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store,
      bootstrapEmail: undefined,
      bootstrapPassword: undefined,
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, true);
    assert.equal(result.totalUsers, 0);
    assert.equal(store.rows.length, 0);
    assert.equal(store.firstAdminCalls, 0);
  });

  it('refuses too-short password (falls back to /setup)', async () => {
    const store = new InMemoryUserStore();
    const result = await runAuthBootstrap({
      userStore: store,
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
      userStore: store,
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
    store.seed('existing@example.com', 'setup_wizard');
    const result = await runAuthBootstrap({
      userStore: store,
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'pw-with-12-chars',
      bootstrapDisplayName: undefined,
      log: () => {},
    });
    assert.equal(result.seeded, false);
    assert.equal(result.setupRequired, false);
    assert.equal(result.totalUsers, 1);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.user.email, 'existing@example.com');
    assert.equal(store.firstAdminCalls, 0, 'the cheap count short-circuits before the lock');
  });
});
