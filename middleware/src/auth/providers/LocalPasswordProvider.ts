import { isSameLoginAccount } from '../loginAccount.js';
import { credentialEpoch } from '../loginDevices.js';
import type { UserStore } from '../userStore.js';
import { verifyPassword } from '../passwordHasher.js';
import { MAX_PASSWORD_LENGTH } from '../passwordPolicy.js';
import type { PasswordAuthResult, PasswordProvider } from './AuthProvider.js';

/**
 * Local username+password authentication backed by the `users` table.
 *
 * Hash verification uses argon2id via passwordHasher. Failure paths return
 * the same `invalid_credentials` code regardless of whether the email
 * exists, the password mismatched, or the account is disabled — keeps the
 * error-channel free of user-enumeration leaks (the timing channel is
 * mitigated implicitly by argon2's constant-time compare and a fixed-cost
 * dummy hash on miss). `user_disabled` is the one code that names an account,
 * so it is returned only after the password verified: every password-less
 * attempt, whatever the row says, gets `invalid_credentials` after one verify.
 *
 * Attempt limits are not this class's job: `POST /login/:id` runs every
 * call through the sign-in rate limiter first (routes/authLogin.ts,
 * docs/security-architecture.md §10m) — per-client, per-(account, client)
 * backoff instead of a hard lockout, plus a cap on concurrent argon2 runs.
 * Its two duties towards the limiter: an attempt only signs in to an account
 * whose address folds to the key the limiter counted it under, and a success
 * reports the credential epoch of the row and hash it compared the password
 * with (`credentialEpoch`), which the sign-in's device cookie is bound to.
 *
 * Out-of-scope for V1 (per John-decision):
 *   - Self-service signup (admin provisions users via an admin endpoint)
 *   - Email-link password reset (admin-reset only)
 */

/** Provider-id used in the users table + AUTH_PROVIDERS env-var. */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * Longest password a sign-in attempt may carry: the shared maximum of
 * `passwordPolicy.ts`, which every password setter applies as well, so no
 * setter can store a password this check refuses. Longer ones are refused
 * as `invalid_credentials` before the users-table lookup, so they never
 * reach argon2 either.
 */
export const MAX_LOGIN_PASSWORD_LENGTH = MAX_PASSWORD_LENGTH;

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface LoginCredentials {
  /** The address the users table is asked for: trimmed. */
  email: string;
  /** The address exactly as sent — what the sign-in limiter keyed the attempt by. */
  typed: string;
  password: string;
}

function readLoginBody(body: unknown): LoginCredentials | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as LoginBody;
  if (typeof b.email !== 'string' || b.email.length === 0) return null;
  if (typeof b.password !== 'string' || b.password.length === 0) return null;
  if (b.password.length > MAX_LOGIN_PASSWORD_LENGTH) return null;
  // Trim email surroundings — passwords are taken as-is (whitespace is
  // legitimate password material).
  return { email: b.email.trim(), typed: b.email, password: b.password };
}

export class LocalPasswordProvider implements PasswordProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly displayName = 'Email & Password';
  readonly kind = 'password' as const;

  constructor(private readonly userStore: UserStore) {}

  async verify(body: unknown): Promise<PasswordAuthResult> {
    const creds = readLoginBody(body);
    if (!creds) {
      return {
        outcome: 'error',
        code: 'invalid_credentials',
        message: `login body must contain non-empty email + password fields (password at most ${String(MAX_LOGIN_PASSWORD_LENGTH)} characters)`,
      };
    }

    const user = await this.userStore.findByEmailWithHash(
      this.id,
      creds.email,
    );

    // The sign-in limiter counted this attempt under the folded address as
    // sent (auth/loginAccount.ts). An account whose own address folds to
    // another key, which a database collation or Unicode version could still
    // match, or which the sent value only reaches after trimming past the
    // fold's input cap, is no match here: an attempt never signs in outside
    // the budget it was counted in. For the shipped databases the fold is
    // coarser than LOWER(), so this never turns away an address as typed.
    if (!user || !user.passwordHash || !isSameLoginAccount(this.id, user.email, creds.typed)) {
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

    const ok = await verifyPassword(user.passwordHash, creds.password);
    if (!ok) {
      return {
        outcome: 'error',
        code: 'invalid_credentials',
        message: `password mismatch for ${creds.email}`,
      };
    }

    // After the verify, never before it: checking the status first made
    // `user_disabled` an enumeration oracle readable without a password (#1311).
    if (user.status !== 'active') {
      return {
        outcome: 'error',
        code: 'user_disabled',
        message: `local user ${creds.email} is disabled`,
      };
    }

    // Stamp last-login asynchronously — callers don't wait on it.
    void this.userStore.markLoginNow(user.id).catch(() => undefined);

    return {
      outcome: 'success',
      providerUserId: user.providerUserId,
      email: user.email,
      displayName: user.displayName || user.email,
      // The row the hash was checked against — the session is minted for it.
      account: { id: user.id, sessionVersion: user.sessionVersion },
      // The hash just compared, not the row as it may read by now: a reset
      // that landed meanwhile must not count for this sign-in.
      credentialEpoch: credentialEpoch({ id: user.id, passwordHash: user.passwordHash }),
    };
  }
}

/** Pre-computed argon2id hash of a fixed long random string. Used for the
 *  dummy verify on the unknown-user path so timing across the two error-
 *  branches matches. The plaintext is intentionally not stored. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$YXV0aG9yY2RDV2VlcmFuZG9t$Bg5p2P4Bd5XKEPS8d7Tt+Iy0pRkBn0PpVeJq8AcK6Wo';
