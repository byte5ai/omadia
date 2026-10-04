import { hashPassword } from './passwordHasher.js';
import {
  checkNewPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from './passwordPolicy.js';
import { LOCAL_PROVIDER_ID } from './providers/LocalPasswordProvider.js';
import type { UserStore } from './userStore.js';

/**
 * First-boot user-bootstrap. Two paths:
 *
 *   1. env-seed: when ADMIN_BOOTSTRAP_EMAIL + ADMIN_BOOTSTRAP_PASSWORD
 *      are set AND the users table is empty, create a single admin row
 *      so the OSS-Demo can log in immediately after `docker compose up`
 *      with declarative `.env` values.
 *
 *   2. setup wizard: when env-seed isn't usable (env unset OR users
 *      already present), `POST /api/v1/auth/setup` opens as a one-shot
 *      endpoint, gated by the operator's setup token (`auth/setupToken.ts`).
 *      It locks itself after the first user is created — see
 *      `routes/authSetup.ts`.
 *
 * Both paths create the admin through `UserStore.createFirstAdmin`, which
 * re-checks emptiness under a table lock. Two replicas booting together
 * therefore seed exactly one admin, and the loser logs a skip instead of
 * crashing on a unique violation.
 *
 * Idempotency: if any user already exists, both paths no-op (env-seed
 * skipped, setup endpoint refuses). Re-running this on every boot is
 * safe and cheap (single COUNT(*) query against a small table).
 */

export interface BootstrapResult {
  /** True when this boot ran the env-seed path successfully. */
  seeded: boolean;
  /**
   * True when the users table is empty AND no env-seed values were given
   * → the operator must complete /setup before /login becomes useful.
   * False when a user already exists OR was just seeded.
   */
  setupRequired: boolean;
  /** Total users known to the store (post-seed). */
  totalUsers: number;
}

export interface AuthBootstrapDeps {
  userStore: Pick<UserStore, 'count' | 'createFirstAdmin'>;
  /** Reads from the validated config bag — passing the values explicitly
   *  rather than the whole Config keeps this testable. */
  bootstrapEmail: string | undefined;
  bootstrapPassword: string | undefined;
  bootstrapDisplayName: string | undefined;
  log?: (msg: string) => void;
}

export async function runAuthBootstrap(
  deps: AuthBootstrapDeps,
): Promise<BootstrapResult> {
  const log = deps.log ?? ((m) => console.log(m));
  const existing = await deps.userStore.count();

  if (existing > 0) {
    return { seeded: false, setupRequired: false, totalUsers: existing };
  }

  const email = (deps.bootstrapEmail ?? '').trim();
  const password = deps.bootstrapPassword ?? '';
  const displayName = (deps.bootstrapDisplayName ?? '').trim();

  if (email.length === 0 || password.length === 0) {
    log(
      '[auth] bootstrap: users table empty and no ADMIN_BOOTSTRAP_EMAIL/PASSWORD set — /setup wizard will be unlocked until first user is created',
    );
    return { seeded: false, setupRequired: true, totalUsers: 0 };
  }
  if (!email.includes('@')) {
    log(
      `[auth] bootstrap: ADMIN_BOOTSTRAP_EMAIL "${email}" is not a valid email — falling back to /setup wizard`,
    );
    return { seeded: false, setupRequired: true, totalUsers: 0 };
  }
  const violation = checkNewPassword(password);
  if (violation === 'too_short') {
    log(
      `[auth] bootstrap: ADMIN_BOOTSTRAP_PASSWORD is shorter than ${String(MIN_PASSWORD_LENGTH)} chars — refusing to seed, falling back to /setup wizard`,
    );
    return { seeded: false, setupRequired: true, totalUsers: 0 };
  }
  if (violation === 'too_long') {
    // Sign-in refuses it, so the seeded admin could never sign in. Stop the
    // boot before anything is hashed or written: the operator meant to set a
    // working password, and an open wizard would hide that it did not work.
    throw new Error(
      `[auth] bootstrap: ADMIN_BOOTSTRAP_PASSWORD is longer than ${String(MAX_PASSWORD_LENGTH)} characters, the most sign-in accepts — shorten it and restart; no account was created`,
    );
  }

  const passwordHash = await hashPassword(password);
  const result = await deps.userStore.createFirstAdmin({
    email,
    provider: LOCAL_PROVIDER_ID,
    providerUserId: email.toLowerCase(),
    passwordHash,
    displayName: displayName.length > 0 ? displayName : email,
    via: 'env_seed',
  });
  if (result.outcome === 'not_empty') {
    log(
      '[auth] bootstrap: users table was populated by another replica while seeding — skipping env-seed',
    );
    return { seeded: false, setupRequired: false, totalUsers: result.totalUsers };
  }
  log(
    `[auth] bootstrap: seeded first admin user (${result.user.email}, id=${result.user.id}) from ADMIN_BOOTSTRAP_* env`,
  );
  return { seeded: true, setupRequired: false, totalUsers: 1 };
}
