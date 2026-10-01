/**
 * Which browsers are known devices of an account, for the password sign-in
 * limiter (docs/security-architecture.md §10f). A browser is one for an
 * account when it carries a device cookie (`./loginDeviceCookie.ts`) for that
 * account that was minted under the account's CURRENT credential epoch:
 *
 *   epoch = SHA-256 over the users row id and its password hash, for an
 *           active row; none for a disabled, missing or hash-less one.
 *
 * A password reset writes a new hash (argon2 salts are random), so every
 * cookie minted before it is stale. A disabled account has no epoch while it
 * stays disabled; re-enabling it without a reset lets its earlier cookies
 * count again. A deleted account has none, and a re-created one gets a new
 * row id. Nothing is stored per device.
 *
 * Reading an epoch is a users-table lookup. It happens only for a cookie whose
 * tag already checks out, one at a time per account, and the result is cached
 * per account for EPOCH_CACHE_TTL_MS, so a stream of requests carrying one
 * stale cookie is not a stream of queries, however many arrive at once. The
 * admin routes that create, reset, disable, re-enable or delete an account
 * call `forget`, so this process stops honouring a revoked epoch at once;
 * another replica may honour it until its cache entry expires.
 *
 * Issuing and checking are best-effort: a failed lookup sets no cookie and
 * counts the browser as unknown (logged at most once a minute), but never
 * fails a sign-in or `GET /me`.
 */

import { createHash } from 'node:crypto';

import type { Request, Response } from 'express';

import {
  createLoginDeviceCookies,
  LOGIN_DEVICE_COOKIE,
  setLoginDeviceCookie,
} from './loginDeviceCookie.js';
import { loginAccountKey, normaliseLoginAccountId } from './loginRateLimiter.js';
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
  /** As sent (an email for `local`); normalised like `loginAccountKey`. */
  readonly accountId: string | undefined;
}

/**
 * Reads an account's credential epoch: an opaque value that changes whenever
 * the account's password does, or null when there is no such active account.
 * `accountId` arrives normalised (trimmed, lower-cased).
 */
export type LoginAccountEpochs = (providerId: string, accountId: string) => Promise<string | null>;

export interface LoginDevices {
  /** The device id when `req` carries a current device cookie for `account`, else null. */
  knownDeviceOf(req: Request, account: LoginAccount): Promise<string | null>;
  /**
   * Give `res` a device cookie for `account` under its current epoch, or none
   * when it has no epoch. A random id, or with `authTime` the one id of that
   * sign-in, so `GET /me` hands out one id per sign-in however often it runs.
   */
  remember(
    req: Request,
    res: Response,
    account: LoginAccount,
    opts?: { authTime?: number },
  ): Promise<void>;
  /** The account's password, status or existence changed: look its epoch up afresh. */
  forget(accountKey: string): void;
}

/** Epochs of `users`-table accounts: the row id and password hash of an ACTIVE row. */
export function usersTableEpochs(
  store: Pick<UserStore, 'findByEmailWithHash'>,
): LoginAccountEpochs {
  return async (providerId, accountId) => {
    const user = await store.findByEmailWithHash(providerId, accountId);
    if (!user || user.status !== 'active' || !user.passwordHash) return null;
    return createHash('sha256').update(`${user.id}\n${user.passwordHash}`).digest('base64url');
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
  /** One lookup per account at a time: concurrent checks wait for it. */
  const inFlight = new Map<string, Promise<string | null>>();
  /** Bumped by `forget`: a lookup that overlapped one does not fill the cache. */
  let forgets = 0;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  async function lookUp(
    accountKey: string,
    providerId: string,
    accountId: string,
  ): Promise<string | null> {
    const startedWith = forgets;
    const epoch = await opts.epochs(providerId, accountId);
    if (forgets === startedWith) {
      cache.delete(accountKey);
      const oldest = cache.size >= EPOCH_CACHE_MAX_ENTRIES ? cache.keys().next() : undefined;
      if (oldest && !oldest.done) cache.delete(oldest.value);
      cache.set(accountKey, { epoch, at: now() });
    }
    return epoch;
  }

  async function epochOf(accountKey: string, account: LoginAccount): Promise<string | null> {
    const accountId = normaliseLoginAccountId(account.accountId);
    if (accountId === undefined) return null;
    const hit = cache.get(accountKey);
    if (hit && now() - hit.at < EPOCH_CACHE_TTL_MS) return hit.epoch;
    const pending = inFlight.get(accountKey);
    if (pending) return pending;
    const lookup = lookUp(accountKey, account.providerId, accountId);
    inFlight.set(accountKey, lookup);
    try {
      return await lookup;
    } finally {
      if (inFlight.get(accountKey) === lookup) inFlight.delete(accountKey);
    }
  }

  function reportFailure(what: string, err: unknown): void {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    warn(
      `[auth] sign-in device cookie: ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    async knownDeviceOf(req, account) {
      const accountKey = loginAccountKey(account.providerId, account.accountId);
      const cookie = cookies.read(readDeviceCookie(req), accountKey);
      // Anything whose tag does not check out costs no lookup.
      if (!cookie) return null;
      try {
        const epoch = await epochOf(accountKey, account);
        return epoch !== null && cookies.isCurrent(cookie, epoch) ? cookie.id : null;
      } catch (err) {
        reportFailure('checking a cookie', err);
        return null;
      }
    },

    async remember(req, res, account, rememberOpts = {}) {
      const accountKey = loginAccountKey(account.providerId, account.accountId);
      let epoch: string | null;
      try {
        epoch = await epochOf(accountKey, account);
      } catch (err) {
        reportFailure('issuing a cookie', err);
        return;
      }
      if (epoch === null) return;
      const id =
        rememberOpts.authTime === undefined
          ? undefined
          : cookies.sessionDeviceId(accountKey, rememberOpts.authTime);
      setLoginDeviceCookie(req, res, cookies.mint(accountKey, epoch, id === undefined ? {} : { id }));
    },

    forget(accountKey) {
      forgets += 1;
      cache.delete(accountKey);
      // A check that starts after this must not join a lookup from before it.
      inFlight.delete(accountKey);
    },
  };
}

function readDeviceCookie(req: Request): string | undefined {
  const jar = (req as Request & { cookies?: Record<string, string> }).cookies;
  return jar?.[LOGIN_DEVICE_COOKIE];
}
