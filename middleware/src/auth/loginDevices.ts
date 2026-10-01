/**
 * Which browsers are known devices of an account, for the password sign-in
 * limiter (docs/security-architecture.md §10f).
 *
 * Only a successful password sign-in (or the first-user wizard, which sets the
 * password) gives a browser a device cookie (`./loginDeviceCookie.ts`), and
 * only for the account that sign-in VERIFIED, never for the address as typed:
 * the cookie's tag covers that account's device key (`loginDeviceAccountKey`
 * of its address as stored), and its `ep` fingerprints that account's
 * credential epoch:
 *
 *   epoch = SHA-256 over the users row id and its password hash, for an
 *           active row; none for a disabled, missing or hash-less one.
 *
 * The cookie is minted under the epoch the sign-in itself checked: the row
 * and the hash the provider compared the password with
 * (`AuthSuccess.credentialEpoch`), or the row and hash the wizard just wrote.
 * Never under an epoch read after that check: a reset that lands while a
 * sign-in with the old password is being verified would otherwise hand that
 * sign-in a cookie for the new password, which it never proved.
 *
 * A request counts as one of an account's known browsers when the address it
 * names has the cookie's device key, and the users-table lookup of that key
 * lands on an active row whose epoch is the one the cookie was minted under.
 * The device key lower-cases ASCII letters only, so that lookup lands where
 * the lookup of the address itself does (except under a collation that
 * lower-cases a capital I its own way, see `./loginAccount.ts`); a spelling
 * that differs from the stored address beyond ASCII case names no known
 * browser. A session alone makes no known browser: `GET /me` sets no device
 * cookie.
 *
 * A password reset writes a new hash (argon2 salts are random), so every
 * cookie minted before it is stale, and so is the cookie of a sign-in that
 * was still comparing against the old hash when it landed: only a sign-in
 * that checked the new password mints a current one. A disabled account has
 * no epoch while it stays disabled; re-enabling it without a reset lets its
 * earlier cookies count again, which gives their holders nothing: each of
 * them signed in with that unchanged password. A deleted account has none,
 * and a re-created one gets a new row id. Nothing is stored per device.
 *
 * Reading an epoch is a users-table lookup. It happens only for a cookie whose
 * tag already checks out, one at a time per device key, and the result is
 * cached per device key for EPOCH_CACHE_TTL_MS, so a stream of requests
 * carrying one stale cookie is not a stream of queries, however many arrive
 * at once. The admin routes that create, reset, disable, re-enable or delete
 * an account call `forget`, so this process stops honouring a revoked epoch
 * at once; another replica may honour it until its cache entry expires.
 *
 * Issuing needs no lookup. Checking is best-effort: a failed lookup counts the
 * browser as unknown (logged at most once a minute), but never fails a
 * sign-in.
 */

import { createHash } from 'node:crypto';

import type { Request, Response } from 'express';

import { loginDeviceAccountKey, loginDeviceAccountName } from './loginAccount.js';
import {
  createLoginDeviceCookies,
  LOGIN_DEVICE_COOKIE,
  setLoginDeviceCookie,
} from './loginDeviceCookie.js';
import type { UserStore } from './userStore.js';

/** How long a looked-up epoch is reused. */
export const EPOCH_CACHE_TTL_MS = 10_000;
/** Accounts whose epoch is cached at most; the oldest lookup goes first. */
const EPOCH_CACHE_MAX_ENTRIES = 1_000;
/** At most one warning per interval when lookups fail (a database outage). */
const WARN_INTERVAL_MS = 60_000;

/** An account as a sign-in names it. */
export interface LoginAccount {
  readonly providerId: string;
  /** As typed (an email for `local`). */
  readonly accountId: string | undefined;
}

/** The account a sign-in verified, and the credentials it verified. */
export interface VerifiedLoginAccount {
  readonly providerId: string;
  /** Its address exactly as the users table stores it. */
  readonly email: string;
  /**
   * The credential epoch the sign-in checked (`credentialEpoch` of the row
   * and hash it compared with), never one read afterwards.
   */
  readonly epoch: string;
}

/** A users row as a credential epoch covers it: which row, under which password. */
export interface CredentialRow {
  readonly id: string;
  readonly passwordHash: string;
}

/**
 * The credential epoch of a users row: SHA-256 over its id and its password
 * hash. Opaque and one-way; it never leaves the process (a cookie carries an
 * HMAC fingerprint of it), and it is never logged.
 */
export function credentialEpoch(row: CredentialRow): string {
  return createHash('sha256').update(`${row.id}\n${row.passwordHash}`).digest('base64url');
}

/**
 * Reads the credential epoch of the account the users table finds for
 * `accountId`, matched as a sign-in matches it: an opaque value that changes
 * whenever the account's password does, or null when there is no such active
 * account.
 */
export type LoginAccountEpochs = (providerId: string, accountId: string) => Promise<string | null>;

export interface LoginDevices {
  /** The device id when `req` carries a current device cookie for the account `typed` names, else null. */
  knownDeviceOf(req: Request, typed: LoginAccount): Promise<string | null>;
  /**
   * Give `res` a device cookie, with a fresh id, for the account a sign-in
   * verified, under the epoch that sign-in checked: no lookup, so a reset
   * that landed meanwhile leaves the cookie stale. None without an address.
   */
  remember(req: Request, res: Response, verified: VerifiedLoginAccount): void;
  /** The account with this device key (`loginDeviceAccountKey`) changed: look it up afresh. */
  forget(deviceKey: string): void;
}

/** Epochs of `users`-table accounts: the row id and password hash of an ACTIVE row. */
export function usersTableEpochs(
  store: Pick<UserStore, 'findByEmailWithHash'>,
): LoginAccountEpochs {
  return async (providerId, accountId) => {
    const user = await store.findByEmailWithHash(providerId, accountId);
    if (!user || user.status !== 'active' || !user.passwordHash) return null;
    return credentialEpoch({ id: user.id, passwordHash: user.passwordHash });
  };
}

export function createLoginDevices(opts: {
  signingKey: Uint8Array;
  epochs: LoginAccountEpochs;
  now?: () => number;
  warn?: (msg: string) => void;
}): LoginDevices {
  const cookies = createLoginDeviceCookies(opts.signingKey);
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const cache = new Map<string, { readonly epoch: string | null; readonly at: number }>();
  /** One lookup per device key at a time: concurrent checks wait for it. */
  const inFlight = new Map<string, Promise<string | null>>();
  /** Bumped by `forget`: a lookup that overlapped one does not fill the cache. */
  let forgets = 0;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  async function lookUp(deviceKey: string, providerId: string, name: string): Promise<string | null> {
    const startedWith = forgets;
    const epoch = await opts.epochs(providerId, name);
    if (forgets === startedWith) {
      cache.delete(deviceKey);
      const oldest = cache.size >= EPOCH_CACHE_MAX_ENTRIES ? cache.keys().next() : undefined;
      if (oldest && !oldest.done) cache.delete(oldest.value);
      cache.set(deviceKey, { epoch, at: now() });
    }
    return epoch;
  }

  async function epochOf(deviceKey: string, providerId: string, name: string): Promise<string | null> {
    const hit = cache.get(deviceKey);
    if (hit && now() - hit.at < EPOCH_CACHE_TTL_MS) return hit.epoch;
    const pending = inFlight.get(deviceKey);
    if (pending) return pending;
    const lookup = lookUp(deviceKey, providerId, name);
    inFlight.set(deviceKey, lookup);
    try {
      return await lookup;
    } finally {
      if (inFlight.get(deviceKey) === lookup) inFlight.delete(deviceKey);
    }
  }

  function reportLookupFailure(err: unknown): void {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    warn(
      `[auth] sign-in device cookie: checking a cookie failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    async knownDeviceOf(req, typed) {
      const name = loginDeviceAccountName(typed.accountId);
      if (name === undefined) return null;
      const deviceKey = `${typed.providerId}:${name}`;
      const cookie = cookies.read(readDeviceCookie(req), deviceKey);
      // Anything whose tag does not check out for this key costs no lookup.
      if (!cookie) return null;
      try {
        const epoch = await epochOf(deviceKey, typed.providerId, name);
        return epoch !== null && cookies.isCurrent(cookie, epoch) ? cookie.id : null;
      } catch (err) {
        reportLookupFailure(err);
        return null;
      }
    },

    remember(req, res, verified) {
      const deviceKey = loginDeviceAccountKey(verified.providerId, verified.email);
      if (deviceKey === undefined) return;
      // The epoch the sign-in checked, not the account's epoch now: reading
      // it afresh would bind the cookie to a password reset that landed
      // after the check, i.e. to a password this sign-in never proved.
      setLoginDeviceCookie(req, res, cookies.mint(deviceKey, verified.epoch));
    },

    forget(deviceKey) {
      forgets += 1;
      cache.delete(deviceKey);
      // A check that starts after this must not join a lookup from before it.
      inFlight.delete(deviceKey);
    },
  };
}

function readDeviceCookie(req: Request): string | undefined {
  const jar = (req as Request & { cookies?: Record<string, string> }).cookies;
  return jar?.[LOGIN_DEVICE_COOKIE];
}
