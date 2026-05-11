import type { UserStore } from '../userStore.js';
import { verifyPassword } from '../passwordHasher.js';
import type { AuthResult, PasswordProvider } from './AuthProvider.js';

/**
 * Local username+password authentication backed by the `users` table.
 *
 * Hash verification uses argon2id via passwordHasher. Failure paths return
 * the same `invalid_credentials` code regardless of whether the email
 * exists or the password mismatched — keeps the error-channel free of
 * user-enumeration leaks (the timing channel is mitigated implicitly by
 * argon2's constant-time compare and a fixed-cost dummy hash on miss).
 *
 * Out-of-scope for V1 (per Marcel-decision):
 *   - Self-service signup (admin provisions users via an admin endpoint)
 *   - Email-link password reset (admin-reset only)
 *   - Account-lockout after N failed tries (V1.x — needs a rate-limit
 *     service in front of /login first)
 */

/** Provider-id used in the users table + AUTH_PROVIDERS env-var. */
export const LOCAL_PROVIDER_ID = 'local';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

function readLoginBody(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as LoginBody;
  if (typeof b.email !== 'string' || b.email.length === 0) return null;
  if (typeof b.password !== 'string' || b.password.length === 0) return null;
  // Trim email surroundings — passwords are taken as-is (whitespace is
  // legitimate password material).
  return { email: b.email.trim(), password: b.password };
}

export class LocalPasswordProvider implements PasswordProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly displayName = 'Email & Password';
  readonly kind = 'password' as const;

  constructor(private readonly userStore: UserStore) {}

  async verify(body: unknown): Promise<AuthResult> {
    const creds = readLoginBody(body);
    if (!creds) {
      return {
        outcome: 'error',
        code: 'invalid_credentials',
        message: 'login body must contain non-empty email + password fields',
      };
    }

    const user = await this.userStore.findByEmailWithHash(
      this.id,
      creds.email,
    );

    if (!user || !user.passwordHash) {
      // Run a dummy verify against a non-trivial hash to keep timing
      // closer to the password-mismatch path. The hash below is the
      // result of argon2id-hashing a long random string; it can never
      // match user input.
      await verifyPassword(DUMMY_HASH, creds.password).catch(() => false);
      return {
        outcome: 'error',
        code: 'invalid_credentials',
        message: `no local user with email ${creds.email}`,
      };
    }

    if (user.status !== 'active') {
      return {
        outcome: 'error',
        code: 'user_disabled',
        message: `local user ${creds.email} is disabled`,
      };
    }

    const ok = await verifyPassword(user.passwordHash, creds.password);
    if (!ok) {
      return {
        outcome: 'error',
        code: 'invalid_credentials',
        message: `password mismatch for ${creds.email}`,
      };
    }

    // Stamp last-login asynchronously — callers don't wait on it.
    void this.userStore.markLoginNow(user.id).catch(() => undefined);

    return {
      outcome: 'success',
      providerUserId: user.providerUserId,
      email: user.email,
      displayName: user.displayName || user.email,
    };
  }
}

/** Pre-computed argon2id hash of a fixed long random string. Used for the
 *  dummy verify on the unknown-user path so timing across the two error-
 *  branches matches. The plaintext is intentionally not stored. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$YXV0aG9yY2RDV2VlcmFuZG9t$Bg5p2P4Bd5XKEPS8d7Tt+Iy0pRkBn0PpVeJq8AcK6Wo';
