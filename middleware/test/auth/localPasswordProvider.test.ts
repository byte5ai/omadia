import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { usersTableEpochs } from '../../src/auth/loginDevices.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import {
  LOCAL_PROVIDER_ID,
  LocalPasswordProvider,
  MAX_LOGIN_PASSWORD_LENGTH,
} from '../../src/auth/providers/LocalPasswordProvider.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import { pgLower } from './loginHarness.js';

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
  /** How often the provider reached the users table. */
  lookups = 0;
  /** How often the provider stamped a last-login, i.e. counted a sign-in. */
  logins = 0;

  /** `match` is the table's LOWER(): two addresses are one row when it maps them alike. */
  constructor(private readonly match: (email: string) => string = (e) => e.toLowerCase()) {}

  async addLocalUser(opts: {
    email: string;
    plainPassword: string;
    status?: 'active' | 'disabled';
    displayName?: string;
  }): Promise<void> {
    const hash = await hashPassword(opts.plainPassword);
    const id = `mock-${this.rows.size + 1}`;
    const now = new Date();
    this.rows.set(this.match(opts.email), {
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
      sessionVersion: 0,
    });
  }

  /** An admin password reset: a new row value with a freshly salted hash. */
  async resetPassword(email: string, plainPassword: string): Promise<void> {
    const row = this.rows.get(this.match(email));
    assert.ok(row, `no user ${email}`);
    this.rows.set(this.match(email), { ...row, passwordHash: await hashPassword(plainPassword) });
  }

  async findByEmailWithHash(
    provider: string,
    email: string,
  ): Promise<UserRecord | null> {
    this.lookups += 1;
    if (provider !== LOCAL_PROVIDER_ID) return null;
    const row = this.rows.get(this.match(email));
    if (!row) return null;
    return row.passwordHash != null
      ? { ...row, passwordHash: row.passwordHash }
      : { ...row, passwordHash: undefined };
  }

  async markLoginNow(_id: string): Promise<void> {
    this.logins += 1;
  }
}

function provider(store: InMemoryUserStore): LocalPasswordProvider {
  return new LocalPasswordProvider(store as unknown as UserStore);
}

/**
 * Milliseconds of the fastest of three `verify` runs. argon2 is only ever
 * slowed down by a loaded machine, so the minimum is the honest cost of the
 * path and the comparison rests on a floor rather than on an average.
 */
async function fastestVerifyMs(
  p: LocalPasswordProvider,
  body: { email: string; password: string },
): Promise<number> {
  let fastest = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    await p.verify(body);
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
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

  it('rejects a disabled user with user_disabled once the password verified', async () => {
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

  it('rejects a disabled user with a wrong password as invalid_credentials (#1311)', async () => {
    // The status must not be readable without the password: a wrong password
    // against a disabled account answers exactly like an unknown address, so
    // `user_disabled` is no enumeration oracle.
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'disabled@example.com',
      plainPassword: 'pw-12345678',
      status: 'disabled',
    });
    const r = await provider(store).verify({
      email: 'disabled@example.com',
      password: 'wrong-pass',
    });
    assert.equal(r.outcome, 'error');
    if (r.outcome === 'error') {
      assert.equal(r.code, 'invalid_credentials');
    }
  });

  it('pays argon2 for a disabled account, like an unknown address does (#1311)', async () => {
    // The code is only half of what the issue asked for: a status check ahead
    // of `verifyPassword` would answer without argon2 at all — microseconds
    // against ~20 ms — and time the account's status out that way. Comparing
    // the two paths pins the ordering itself, where asserting the code cannot:
    // the fastest of three runs each, since argon2 can be delayed by load but
    // never run faster, and a third of the unknown-address cost as the bound.
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'disabled@example.com',
      plainPassword: 'pw-12345678',
      status: 'disabled',
    });
    const p = provider(store);
    const unknown = await fastestVerifyMs(p, { email: 'nobody@example.com', password: 'wrong-pass' });
    const disabled = await fastestVerifyMs(p, {
      email: 'disabled@example.com',
      password: 'wrong-pass',
    });
    assert.ok(
      disabled > unknown / 3,
      `the disabled path took ${disabled.toFixed(1)}ms against ${unknown.toFixed(1)}ms for an unknown address — it looks like it skipped argon2`,
    );
  });

  it('does not stamp last-login for a disabled account with the right password', async () => {
    const store = new InMemoryUserStore();
    await store.addLocalUser({
      email: 'disabled@example.com',
      plainPassword: 'pw-12345678',
      status: 'disabled',
    });
    await provider(store).verify({
      email: 'disabled@example.com',
      password: 'pw-12345678',
    });
    assert.equal(store.logins, 0);
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
      // The session is minted for the row the hash was checked against: its
      // id and session version come from that same read.
      assert.deepEqual(r.account, { id: 'mock-1', sessionVersion: 0 });
    }
  });

  it('refuses an over-long password before the lookup and before argon2', async () => {
    // argon2's pre-hash is linear in the password length and the JSON body
    // limit is 10 MB: the cap keeps a sign-in attempt's cost bounded.
    assert.equal(MAX_LOGIN_PASSWORD_LENGTH, 1024);
    const store = new InMemoryUserStore();
    const longest = 'p'.repeat(MAX_LOGIN_PASSWORD_LENGTH);
    await store.addLocalUser({ email: 'long@example.com', plainPassword: longest });

    const tooLong = await provider(store).verify({
      email: 'long@example.com',
      password: `${longest}p`,
    });
    assert.equal(tooLong.outcome, 'error');
    if (tooLong.outcome === 'error') assert.equal(tooLong.code, 'invalid_credentials');
    assert.equal(store.lookups, 0, 'no users-table lookup, so no argon2 run either');

    const atLimit = await provider(store).verify({ email: 'long@example.com', password: longest });
    assert.equal(atLimit.outcome, 'success');
  });

  it('signs in under a spelling the table matches like Postgres LOWER() does', async () => {
    const store = new InMemoryUserStore(pgLower);
    await store.addLocalUser({ email: 'admin@example.com', plainPassword: 'pw-12345678' });
    const r = await provider(store).verify({ email: 'ADM\u0130N@example.com', password: 'pw-12345678' });
    assert.equal(r.outcome, 'success');
  });

  it('refuses an account the table matches beyond the limiter’s fold, even with the right password', async () => {
    // A table that ignores zero-width spaces stands in for a collation or a
    // newer Unicode version the sign-in limiter's fold does not know: the
    // attempt was counted under another key than the account's (§10m).
    const store = new InMemoryUserStore((e) => e.replace(/\u200b/g, '').toLowerCase());
    await store.addLocalUser({ email: 'admin@example.com', plainPassword: 'pw-12345678' });
    const loose = await provider(store).verify({
      email: 'adm\u200bin@example.com',
      password: 'pw-12345678',
    });
    assert.equal(loose.outcome, 'error');
    if (loose.outcome === 'error') assert.equal(loose.code, 'invalid_credentials');
    const exact = await provider(store).verify({ email: 'Admin@example.com', password: 'pw-12345678' });
    assert.equal(exact.outcome, 'success');
  });

  it('judges the address as sent, so padding the limiter does not fold cannot sign in', async () => {
    // The limiter folds at most ~1000 characters; a longer value shares the
    // provider-wide key, so it must not reach an account after trimming.
    const store = new InMemoryUserStore();
    await store.addLocalUser({ email: 'admin@example.com', plainPassword: 'pw-12345678' });
    const padded = await provider(store).verify({
      email: `${' '.repeat(2_000)}admin@example.com`,
      password: 'pw-12345678',
    });
    assert.equal(padded.outcome, 'error');
    const trimmed = await provider(store).verify({ email: ' admin@example.com ', password: 'pw-12345678' });
    assert.equal(trimmed.outcome, 'success', 'ordinary surrounding whitespace still signs in');
  });

  it('reports the credential epoch of the hash it compared, even when a reset lands meanwhile', async () => {
    const store = new InMemoryUserStore();
    await store.addLocalUser({ email: 'admin@example.com', plainPassword: 'pw-12345678' });
    const epochNow = (): Promise<string | null> =>
      usersTableEpochs(store)(LOCAL_PROVIDER_ID, 'admin@example.com');
    const epochOf = (r: Awaited<ReturnType<LocalPasswordProvider['verify']>>): string | undefined =>
      r.outcome === 'success' ? r.credentialEpoch : undefined;
    const before = await epochNow();
    assert.ok(before);

    const plain = await provider(store).verify({ email: 'admin@example.com', password: 'pw-12345678' });
    assert.equal(epochOf(plain), before, 'the epoch a device-cookie check reads back');

    // The reset lands after the provider read the row, before argon2 ran.
    const read = store.findByEmailWithHash.bind(store);
    store.findByEmailWithHash = async (p: string, e: string) => {
      const row = await read(p, e);
      await store.resetPassword('admin@example.com', 'the password after the reset');
      return row;
    };
    const raced = await provider(store).verify({ email: 'admin@example.com', password: 'pw-12345678' });
    store.findByEmailWithHash = read;
    assert.equal(raced.outcome, 'success', 'it compared the hash it had read');
    const after = await epochNow();
    assert.ok(after !== null && after !== before, 'the reset moved the epoch');
    assert.equal(epochOf(raced), before, 'the old password’s epoch, never the new one');
  });
});
