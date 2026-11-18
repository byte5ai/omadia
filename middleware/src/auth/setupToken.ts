import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

import { isLoopbackAddress } from './loopbackOnly.js';

/**
 * Operator authorisation for the first-user wizard (`POST /api/v1/auth/setup`).
 *
 * The wizard is unauthenticated by necessity (there is no operator yet), and on
 * a fresh install it is the most valuable endpoint the server has: whoever
 * reaches it first becomes the admin. "Reaches it first" is decided by network
 * position, not by who installed the server. So the wizard demands a one-time
 * setup token that only the operator can read: the value of
 * `ADMIN_SETUP_TOKEN`, or — when that is unset — a token the kernel generates
 * and prints to its own log at boot.
 *
 * THE ONE EXEMPTION is the desktop app: its supervisor spawns the kernel with
 * `OMADIA_DESKTOP_EMBEDDED=true` AND binds it to a loopback address, so the
 * wizard is reachable from that machine only and the person at the keyboard is
 * the operator. Both conditions are required. The exemption deliberately does
 * NOT look at request headers (`Host`, `X-Forwarded-For`) or at
 * `PUBLIC_BASE_URL`: behind a reverse proxy every request can look local, and
 * a check a header can satisfy is decoration. A loopback bind alone does not
 * exempt either — a same-host reverse proxy makes a loopback-bound kernel
 * public — and neither does the flag alone.
 *
 * Multi-replica / restarts: a generated token is persisted in
 * `platform_settings` (set-if-absent), so every replica and every restart
 * before setup completes serves and prints the SAME token. The first-admin
 * transaction deletes the row (`UserStore.createFirstAdmin`), and a boot that
 * finds setup already done clears any leftover.
 */

/** Minimum length of an operator-chosen `ADMIN_SETUP_TOKEN` (config.ts enforces it at boot). */
export const SETUP_TOKEN_MIN_LENGTH = 16;

/** Longest token accepted anywhere: config.ts refuses a longer `ADMIN_SETUP_TOKEN`
 *  at boot, and `setupTokenMatches` refuses a longer presented value before hashing. */
export const SETUP_TOKEN_MAX_LENGTH = 512;

/** `platform_settings` key the generated token lives under while setup is pending. */
export const SETUP_TOKEN_SETTING_KEY = 'auth.setup_token';

/** Bytes of entropy in a generated token (base64url → 32 characters). */
const GENERATED_TOKEN_BYTES = 24;

export interface SetupTokenPolicyInput {
  /** `ADMIN_SETUP_TOKEN` — already validated (16–512 chars) or undefined. */
  configured: string | undefined;
  /** `runAuthBootstrap(...).setupRequired`: the wizard is open on this boot. */
  setupRequired: boolean;
  /** `OMADIA_DESKTOP_EMBEDDED` — set only by the desktop app's supervisor. */
  desktopEmbedded: boolean;
  /** `HOST` — the address the kernel's HTTP listener binds. */
  host: string;
}

export type SetupTokenPolicy =
  | { kind: 'env'; token: string }
  | { kind: 'not_needed' }
  | { kind: 'desktop_exempt' }
  | { kind: 'generate' };

/**
 * True only for the desktop kernel: the supervisor's explicit flag AND a
 * literal loopback bind address. `localhost` is not accepted — it is a name,
 * and what it resolves to is not this function's to promise.
 */
export function isDesktopLoopbackKernel(
  input: Pick<SetupTokenPolicyInput, 'desktopEmbedded' | 'host'>,
): boolean {
  return input.desktopEmbedded && isLoopbackAddress(input.host);
}

/**
 * Decide how `/setup` is authorised on this boot. Pure — the boot wiring
 * (`initSetupToken`) does the persistence and logging.
 *
 *   - an operator-configured token always wins;
 *   - no wizard on this boot → no token needed;
 *   - the desktop kernel (flag + loopback bind) → exempt;
 *   - everything else → a generated, persisted token.
 */
export function resolveSetupTokenPolicy(input: SetupTokenPolicyInput): SetupTokenPolicy {
  if (input.configured !== undefined) return { kind: 'env', token: input.configured };
  if (!input.setupRequired) return { kind: 'not_needed' };
  if (isDesktopLoopbackKernel(input)) return { kind: 'desktop_exempt' };
  return { kind: 'generate' };
}

/** A fresh random token: 24 bytes, base64url (32 characters, URL- and shell-safe). */
export function generateSetupToken(): string {
  return randomBytes(GENERATED_TOKEN_BYTES).toString('base64url');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison of a presented token against the expected one.
 * Both sides are hashed first, so the comparison runs on equal-length digests
 * and leaks neither the content nor the length of the expected token. Anything
 * that is not a non-empty string of sane length is refused before hashing.
 */
export function setupTokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  if (received.length === 0 || received.length > SETUP_TOKEN_MAX_LENGTH) return false;
  return timingSafeEqual(sha256(expected), sha256(received));
}

function isUsableToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= SETUP_TOKEN_MIN_LENGTH &&
    value.length <= SETUP_TOKEN_MAX_LENGTH
  );
}

/** Where a generated token is shared between replicas and restarts. */
export interface SetupTokenStore {
  /**
   * Store `candidate` unless a token is already stored; return the token that
   * is stored afterwards. Two replicas claiming concurrently get the same value.
   */
  claim(candidate: string): Promise<string>;
  /** Forget the stored token (setup is over). */
  clear(): Promise<void>;
}

/** `SetupTokenStore` over the `platform_settings` KV of the auth schema. */
export class PgSetupTokenStore implements SetupTokenStore {
  constructor(private readonly pool: Pool) {}

  async claim(candidate: string): Promise<string> {
    // Two statements on purpose. Under READ COMMITTED the SELECT takes a fresh
    // snapshot, so a replica that lost the INSERT race reads the winner's
    // committed value. A single `INSERT … ON CONFLICT DO NOTHING RETURNING`
    // returns nothing to the loser, and a CTE reading the table back would use
    // the statement's own snapshot, which predates the winner's commit.
    await this.pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [SETUP_TOKEN_SETTING_KEY, JSON.stringify(candidate)],
    );
    const res = await this.pool.query<{ value: unknown }>(
      'SELECT value FROM platform_settings WHERE key = $1',
      [SETUP_TOKEN_SETTING_KEY],
    );
    const stored = res.rows[0]?.value;
    if (isUsableToken(stored)) return stored;
    // A hand-edited or truncated row, or the row vanished because setup just
    // completed on another replica: replace rather than boot with a token
    // nobody can type. Harmless in the second case — setup is locked by the
    // users row, and the next boot clears this one.
    await this.pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [SETUP_TOKEN_SETTING_KEY, JSON.stringify(candidate)],
    );
    return candidate;
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM platform_settings WHERE key = $1', [
      SETUP_TOKEN_SETTING_KEY,
    ]);
  }
}

export type SetupTokenSource = 'env' | 'generated' | 'desktop_exempt' | 'not_needed';

export interface SetupTokenBoot {
  /** The token `POST /setup` demands, or undefined when this boot has no token gate. */
  token: string | undefined;
  source: SetupTokenSource;
}

export interface InitSetupTokenDeps extends SetupTokenPolicyInput {
  store: SetupTokenStore;
  /** Injected for tests; defaults to `generateSetupToken`. */
  generate?: () => string;
  log?: (msg: string) => void;
}

/**
 * Boot wiring: resolve the policy, persist or clear the generated token, and
 * print what the operator needs — exactly once per boot, and never an
 * operator-supplied token.
 */
export async function initSetupToken(deps: InitSetupTokenDeps): Promise<SetupTokenBoot> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const policy = resolveSetupTokenPolicy(deps);

  switch (policy.kind) {
    case 'env':
      if (deps.setupRequired) {
        log('[auth] bootstrap: /setup wizard requires the setup token from ADMIN_SETUP_TOKEN');
      }
      return { token: policy.token, source: 'env' };

    case 'not_needed':
      // Setup finished (wizard, env seed or a first OIDC sign-in): a token row a
      // previous boot generated has nothing left to guard.
      try {
        await deps.store.clear();
      } catch (err) {
        log(
          `[auth] bootstrap: could not clear a leftover setup token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { token: undefined, source: 'not_needed' };

    case 'desktop_exempt':
      log(
        '[auth] bootstrap: /setup wizard open without a setup token (desktop app, loopback listener)',
      );
      return { token: undefined, source: 'desktop_exempt' };

    case 'generate': {
      const candidate = (deps.generate ?? generateSetupToken)();
      let token = candidate;
      let shared = true;
      try {
        token = await deps.store.claim(candidate);
      } catch (err) {
        // Still gate the wizard — with a token only this process knows. On a
        // single replica that is indistinguishable; with several, the wizard
        // must be retried against this one or ADMIN_SETUP_TOKEN set.
        shared = false;
        log(
          `[auth] bootstrap: could not persist the setup token (${err instanceof Error ? err.message : String(err)}) — it is valid on this replica only`,
        );
      }
      log(
        `[auth] bootstrap: /setup wizard unlocked — setup token: ${token} ` +
          `(one-time; ${shared ? 'the same on every replica and restart until the first admin exists' : 'this replica only'}; ` +
          'set ADMIN_SETUP_TOKEN to choose your own)',
      );
      return { token, source: 'generated' };
    }
  }
}
