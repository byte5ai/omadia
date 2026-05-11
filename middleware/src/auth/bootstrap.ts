import { hashPassword } from './passwordHasher.js';
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
 *      already present), the caller mounts `POST /api/v1/auth/setup` as
 *      an unauthenticated one-shot endpoint. The endpoint locks itself
 *      after the first user is created — see `routes/auth.ts`.
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
  userStore: UserStore;
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
  if (password.length < 8) {
    log(
      '[auth] bootstrap: ADMIN_BOOTSTRAP_PASSWORD is shorter than 8 chars — refusing to seed, falling back to /setup wizard',
    );
    return { seeded: false, setupRequired: true, totalUsers: 0 };
  }

  const passwordHash = await hashPassword(password);
  const lower = email.toLowerCase();
  const user = await deps.userStore.create({
    email,
    provider: LOCAL_PROVIDER_ID,
    providerUserId: lower,
    passwordHash,
    displayName: displayName.length > 0 ? displayName : email,
    role: 'admin',
  });
  log(
    `[auth] bootstrap: seeded first admin user (${user.email}, id=${user.id}) from ADMIN_BOOTSTRAP_* env`,
  );
  return { seeded: true, setupRequired: false, totalUsers: 1 };
}
