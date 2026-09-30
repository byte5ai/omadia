/**
 * Password sign-in limiter (`POST /api/v1/auth/login/:id`) —
 * docs/security-architecture.md §10f.
 *
 * Every attempt passes three layers, in this order:
 *
 *  1. client  — per client key, a CPU brake. A leaky bucket of FAILURES:
 *     a burst of `clientMaxFailures`, drained at `clientMaxFailures` per
 *     `clientWindowMs` (defaults: 100, one every 6 s). Full → 429 with a
 *     Retry-After of at most `clientMaxRetryAfterMs`. Pinned semantics: once
 *     full, the key gets one failure per drain step, never a long lock — behind
 *     a proxy this key may be shared by every browser of the deployment.
 *  2. account — per (account, client) PAIR, the guessing defence.
 *     `accountFreeFailures` free failures, then every further attempt waits
 *     `accountBaseBlockMs × 2^(failures − free)` after the last failure, capped
 *     at `accountMaxBlockMs`. Keyed by the pair, so a client only ever slows
 *     down its OWN attempts on an account: an attacker cannot lock the owner out
 *     from the owner's client (lockout-DoS). A success clears the pair; a pair
 *     is forgotten `accountStateTtlMs` after its last failure. → 429.
 *  3. global  — process-wide argon2 capacity: at most `globalMaxInFlight`
 *     verifications at once and `globalMaxPerMinute` admitted attempts per
 *     minute (leaky bucket, so the Retry-After stays short). Only attempts
 *     layers 1 and 2 admitted consume it, so a flood of cheap refusals can
 *     never turn into a deployment-wide 503. → 503.
 *
 * Counting happens at ADMISSION. An admitted attempt is pending on its client
 * and pair until the caller settles it, and a pending attempt counts as a
 * failure until then: N parallel requests cannot race past the free budget
 * between the check and the verdict. Once a pair's free budget is spent, it
 * gets one attempt at a time.
 *
 * In-memory and per process, like the API-key limiter (§9): a restart clears
 * it, and N replicas multiply every ceiling by N. Memory is bounded — each map
 * holds at most `maxTrackedKeys` entries (least recently used out first) and
 * expired entries are swept every `sweepIntervalMs` from `admit()` itself, so
 * a limiter nobody sweeps from outside stays bounded too.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** Headroom for floating-point drift in the leaky buckets. */
const EPSILON = 1e-9;
/** 2^30 × base is far beyond any sane cap; stops the exponent growing unboundedly. */
const MAX_BACKOFF_EXPONENT = 30;
/** RFC 5321 bounds a mailbox at 254 characters; longer ids share one key. */
const MAX_ACCOUNT_ID_LENGTH = 254;
const GLOBAL_REPORT_KEY = 'global';

export type LoginLimitScope = 'client' | 'account' | 'global';

export interface LoginKeys {
  /** Who is asking: `clientAddressFor(...)`, or `device:<id>` for a valid device cookie. */
  readonly clientKey: string;
  /** What is being guessed: `loginAccountKey(providerId, accountId)`. */
  readonly accountKey: string;
}

export interface LoginRefusal {
  readonly allowed: false;
  readonly scope: LoginLimitScope;
  /** Whole seconds, at least 1 — the `Retry-After` value. */
  readonly retryAfterS: number;
  /**
   * True for the first refusal of this (scope, client) within
   * `reportIntervalMs` (for `global`: of any client). Log and audit only then,
   * so a refusal flood cannot become a log or database write flood.
   */
  readonly report: boolean;
}

/** An admitted attempt. Settle it exactly once; later calls are no-ops. */
export interface LoginAttempt {
  /** The credentials were accepted: clears the pair, frees the slot. */
  succeed(): void;
  /** Anything else — counted against client and pair, frees the slot. */
  fail(): void;
}

export type LoginAdmission =
  | { readonly allowed: true; readonly attempt: LoginAttempt }
  | LoginRefusal;

export interface LoginLimiterStats {
  readonly clients: number;
  readonly pairs: number;
  readonly inFlight: number;
}

export interface LoginRateLimiter {
  /** Run the three layers; on admission the attempt holds a global slot. */
  admit(keys: LoginKeys): LoginAdmission;
  /**
   * A bare global slot for other unauthenticated argon2 work (the first-user
   * wizard's hash). Returns the release function, or null when saturated.
   */
  acquireSlot(): (() => void) | null;
  /** Forget every pair of this account — the operator unlock (reset / re-enable). */
  clearAccount(accountKey: string): void;
  /** Drop drained clients, expired pairs and old report marks. */
  sweep(): void;
  /** Tracked keys and in-flight count, for diagnostics and tests. */
  stats(): LoginLimiterStats;
}

export interface LoginLimiterConfig {
  readonly clientMaxFailures: number;
  readonly clientWindowMs: number;
  readonly clientMaxRetryAfterMs: number;
  readonly accountFreeFailures: number;
  readonly accountBaseBlockMs: number;
  readonly accountMaxBlockMs: number;
  readonly accountStateTtlMs: number;
  readonly globalMaxInFlight: number;
  readonly globalMaxPerMinute: number;
  readonly maxTrackedKeys: number;
  readonly reportIntervalMs: number;
  readonly sweepIntervalMs: number;
}

export const DEFAULT_LOGIN_LIMITER_CONFIG: LoginLimiterConfig = Object.freeze({
  clientMaxFailures: 100,
  clientWindowMs: 10 * MINUTE,
  clientMaxRetryAfterMs: 15 * SECOND,
  accountFreeFailures: 5,
  accountBaseBlockMs: SECOND,
  accountMaxBlockMs: 2 * MINUTE,
  accountStateTtlMs: 30 * MINUTE,
  globalMaxInFlight: 4,
  globalMaxPerMinute: 300,
  maxTrackedKeys: 10_000,
  reportIntervalMs: MINUTE,
  sweepIntervalMs: MINUTE,
});

/**
 * The account a sign-in attempt targets, namespaced by provider and
 * normalised like the users table (`LOWER(email)`, and the provider trims):
 * `' Admin@X.de '` and `'admin@x.de'` are one account. A missing, empty or
 * oversized id collapses to `'-'`.
 */
export function loginAccountKey(providerId: string, accountId: string | undefined): string {
  const id = (accountId ?? '').trim().toLowerCase();
  const safe = id.length > 0 && id.length <= MAX_ACCOUNT_ID_LENGTH ? id : '-';
  return `${providerId}:${safe}`;
}

/**
 * The account id in a password-provider login body. Providers define their
 * own body shape (`PasswordProvider.verify(body: unknown)`); every provider
 * this repo has identifies the account by `email`, and `username` covers the
 * obvious other shape. Anything else shares the provider-wide `'-'` key.
 */
export function readLoginAccountId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { email?: unknown; username?: unknown };
  if (typeof b.email === 'string') return b.email;
  if (typeof b.username === 'string') return b.username;
  return undefined;
}

interface ClientState {
  level: number;
  updatedAt: number;
  pending: number;
}

interface PairState {
  readonly accountKey: string;
  failures: number;
  lastFailureAt: number;
  pending: number;
}

interface Bucket {
  level: number;
  updatedAt: number;
}

/** A leaky bucket's level at `t`, draining `amount` per `windowMs`. */
function drainedLevel(b: Bucket, t: number, amount: number, windowMs: number): number {
  return Math.max(0, b.level - ((t - b.updatedAt) * amount) / windowMs);
}

/** Map with an LRU order: `touch` moves a key to the young end. */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/** Make room for one more entry, evicting the least recently used idle ones. */
function makeRoom<V>(map: Map<string, V>, cap: number, isBusy: (v: V) => boolean): void {
  if (map.size < cap) return;
  for (const [key, value] of map) {
    if (map.size < cap) return;
    if (!isBusy(value)) map.delete(key);
  }
}

export function createLoginRateLimiter(
  config: LoginLimiterConfig = DEFAULT_LOGIN_LIMITER_CONFIG,
  now: () => number = Date.now,
): LoginRateLimiter {
  const clients = new Map<string, ClientState>();
  const pairs = new Map<string, PairState>();
  const reported = new Map<string, number>();
  const global = { level: 0, updatedAt: now(), inFlight: 0 };
  let lastSweepAt = now();

  const clientLevel = (s: ClientState, t: number): number =>
    drainedLevel(s, t, config.clientMaxFailures, config.clientWindowMs);
  const globalLevel = (t: number): number =>
    drainedLevel(global, t, config.globalMaxPerMinute, MINUTE);

  function clientWaitMs(s: ClientState | undefined, t: number): number {
    if (!s) return 0;
    const excess = clientLevel(s, t) + s.pending + 1 - config.clientMaxFailures;
    if (excess <= EPSILON) return 0;
    const drainMs = (excess * config.clientWindowMs) / config.clientMaxFailures;
    return Math.min(config.clientMaxRetryAfterMs, drainMs);
  }

  function pairWaitMs(s: PairState | undefined, t: number): number {
    if (!s) return 0;
    if (s.failures + s.pending < config.accountFreeFailures) return 0;
    // Free budget spent (or about to be): one attempt at a time.
    if (s.pending > 0) return SECOND;
    const exponent = Math.min(s.failures - config.accountFreeFailures, MAX_BACKOFF_EXPONENT);
    const blockMs = Math.min(config.accountMaxBlockMs, config.accountBaseBlockMs * 2 ** exponent);
    return Math.max(0, s.lastFailureAt + blockMs - t);
  }

  function globalWaitMs(t: number): number {
    if (global.inFlight >= config.globalMaxInFlight) return SECOND;
    const excess = globalLevel(t) + 1 - config.globalMaxPerMinute;
    if (excess <= EPSILON) return 0;
    return (excess * MINUTE) / config.globalMaxPerMinute;
  }

  function refuse(scope: LoginLimitScope, clientKey: string, waitMs: number, t: number): LoginRefusal {
    const reportKey = scope === 'global' ? GLOBAL_REPORT_KEY : `${scope}\n${clientKey}`;
    const last = reported.get(reportKey);
    const report = last === undefined || t - last >= config.reportIntervalMs;
    if (report) {
      makeRoom(reported, config.maxTrackedKeys, () => false);
      touch(reported, reportKey, t);
    }
    return { allowed: false, scope, retryAfterS: Math.max(1, Math.ceil(waitMs / SECOND)), report };
  }

  /** Take one global slot and one per-minute token. Callers checked capacity. */
  function takeSlot(t: number): () => void {
    global.level = globalLevel(t) + 1;
    global.updatedAt = t;
    global.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      global.inFlight -= 1;
    };
  }

  function sweep(): void {
    const t = now();
    lastSweepAt = t;
    for (const [key, s] of clients) {
      if (s.pending === 0 && clientLevel(s, t) <= EPSILON) clients.delete(key);
    }
    for (const [key, s] of pairs) {
      if (s.pending === 0 && t - s.lastFailureAt >= config.accountStateTtlMs) pairs.delete(key);
    }
    for (const [key, at] of reported) {
      if (t - at >= config.reportIntervalMs) reported.delete(key);
    }
  }

  function currentPair(pairKey: string, t: number): PairState | undefined {
    const s = pairs.get(pairKey);
    // Lazily forget a pair whose last failure is older than the TTL.
    if (s && s.pending === 0 && t - s.lastFailureAt >= config.accountStateTtlMs) {
      pairs.delete(pairKey);
      return undefined;
    }
    return s;
  }

  function admit(keys: LoginKeys): LoginAdmission {
    const t = now();
    if (t - lastSweepAt >= config.sweepIntervalMs) sweep();

    const existingClient = clients.get(keys.clientKey);
    const cWait = clientWaitMs(existingClient, t);
    if (cWait > 0) return refuse('client', keys.clientKey, cWait, t);

    const pairKey = JSON.stringify([keys.accountKey, keys.clientKey]);
    const existingPair = currentPair(pairKey, t);
    const pWait = pairWaitMs(existingPair, t);
    if (pWait > 0) return refuse('account', keys.clientKey, pWait, t);

    const gWait = globalWaitMs(t);
    if (gWait > 0) return refuse('global', keys.clientKey, gWait, t);

    if (!existingClient) makeRoom(clients, config.maxTrackedKeys, (s) => s.pending > 0);
    const client = existingClient ?? { level: 0, updatedAt: t, pending: 0 };
    touch(clients, keys.clientKey, client);
    if (!existingPair) makeRoom(pairs, config.maxTrackedKeys, (s) => s.pending > 0);
    const pair = existingPair ?? {
      accountKey: keys.accountKey,
      failures: 0,
      lastFailureAt: t,
      pending: 0,
    };
    touch(pairs, pairKey, pair);
    client.pending += 1;
    pair.pending += 1;
    const release = takeSlot(t);

    let settled = false;
    const settle = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      release();
      const at = now();
      client.pending -= 1;
      pair.pending -= 1;
      if (succeeded) {
        pair.failures = 0;
        if (pair.pending === 0 && pairs.get(pairKey) === pair) pairs.delete(pairKey);
        return;
      }
      client.level = clientLevel(client, at) + 1;
      client.updatedAt = at;
      pair.failures += 1;
      pair.lastFailureAt = at;
    };
    return {
      allowed: true,
      attempt: { succeed: () => settle(true), fail: () => settle(false) },
    };
  }

  return {
    admit,
    acquireSlot(): (() => void) | null {
      const t = now();
      return globalWaitMs(t) > 0 ? null : takeSlot(t);
    },
    clearAccount(accountKey: string): void {
      for (const [key, s] of pairs) {
        if (s.accountKey === accountKey) pairs.delete(key);
      }
    },
    sweep,
    stats: () => ({ clients: clients.size, pairs: pairs.size, inFlight: global.inFlight }),
  };
}
