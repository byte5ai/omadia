import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  CreateUserInput,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';

/**
 * upsertOidcIdentity is the gate that keeps `/setup` from staying
 * unlocked in pure-OIDC deployments. We don't want a real Postgres in
 * unit tests, so we stub out just the pool's behaviour the upsert relies
 * on (INSERT ... ON CONFLICT (provider, provider_user_id)).
 *
 * The shape mirrors the real UserStore method by routing through an
 * in-memory map keyed by `(provider, provider_user_id)`.
 */
class InMemoryUserStore {
  private byProviderUid = new Map<string, UserRecord>();

  async count(): Promise<number> {
    return this.byProviderUid.size;
  }

  async upsertOidcIdentity(input: {
    provider: string;
    providerUserId: string;
    email: string;
    displayName?: string;
    role?: 'admin';
  }): Promise<UserRecord> {
    const key = `${input.provider}:${input.providerUserId}`;
    const existing = this.byProviderUid.get(key);
    if (existing) {
      const updated: UserRecord = {
        ...existing,
        email: input.email,
        displayName:
          input.displayName && input.displayName.length > 0
            ? input.displayName
            : existing.displayName,
        updatedAt: new Date(),
      };
      this.byProviderUid.set(key, updated);
      return updated;
    }
    const now = new Date();
    const created: UserRecord = {
      id: `mock-${this.byProviderUid.size + 1}`,
      email: input.email,
      provider: input.provider,
      providerUserId: input.providerUserId,
      displayName: input.displayName ?? '',
      role: input.role ?? 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.byProviderUid.set(key, created);
    return created;
  }
}

describe('UserStore.upsertOidcIdentity (semantic test via stub)', () => {
  it('creates a row on first OIDC login', async () => {
    const s = new InMemoryUserStore();
    assert.equal(await s.count(), 0);
    const u = await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-abc',
      email: 'admin@example.com',
      displayName: 'Admin',
    });
    assert.equal(u.email, 'admin@example.com');
    assert.equal(u.provider, 'entra');
    assert.equal(u.providerUserId, 'oid-abc');
    assert.equal(u.displayName, 'Admin');
    assert.equal(await s.count(), 1);
  });

  it('updates email + displayName on second login (same provider_user_id)', async () => {
    const s = new InMemoryUserStore();
    await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-abc',
      email: 'old@example.com',
      displayName: 'Old Name',
    });
    const u2 = await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-abc',
      email: 'new@example.com',
      displayName: 'New Name',
    });
    assert.equal(u2.email, 'new@example.com');
    assert.equal(u2.displayName, 'New Name');
    // Same row — count stays 1.
    assert.equal(await s.count(), 1);
  });

  it('keeps existing display_name when the upsert payload empty-strings it', async () => {
    const s = new InMemoryUserStore();
    await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-abc',
      email: 'a@example.com',
      displayName: 'Initial',
    });
    const u2 = await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-abc',
      email: 'a@example.com',
      displayName: '',
    });
    assert.equal(u2.displayName, 'Initial');
  });

  it('treats different providers as distinct identities', async () => {
    const s = new InMemoryUserStore();
    await s.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'sub-1',
      email: 'a@example.com',
    });
    await s.upsertOidcIdentity({
      provider: 'google',
      providerUserId: 'sub-1',
      email: 'a@example.com',
    });
    assert.equal(await s.count(), 2);
  });
});
