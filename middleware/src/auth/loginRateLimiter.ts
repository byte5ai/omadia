/**
 * Password sign-in limiter (`POST /api/v1/auth/login/:id`) —
 * docs/security-architecture.md §10f.
 *
 * Every attempt names its client by a key of one of three kinds
 * (`LoginClientKind`), and the kind decides which layers apply:
 *
 *   device   a genuine device cookie for the account: one browser that has
 *            signed in to it before;
 *   address  an address a trusted proxy vouched for (`xff:<n>`,
 *            `header:<name>`): one client, or one NAT;
 *   shared   the TCP peer — in every shipped topology a proxy that all
 *            browsers behind it share.
 *
 * The layers, in this order:
 *
 *  1. client  — `address` keys only: a CPU brake per client. A leaky bucket
 *     of FAILURES, a burst of `clientMaxFailures`, drained at
 *     `clientMaxFailures` per `clientWindowMs` (defaults: 100, one every
 *     6 s). Full → 429, each Retry-After at most `clientMaxRetryAfterMs`.
 *     A sender that keeps the bucket full takes every drain step as it
 *     opens, so whoever shares its key waits for as long as it keeps going.
 *     For one address that is the price of a NAT; for the shared TCP peer
 *     it would let one sender lock out every browser of the deployment, so
 *     a `shared` key skips this layer. A `device` key only ever sees its own
 *     account, where layer 2 is stricter, so it skips it too.
 *  2. account — per (account, client) PAIR, every kind: the guessing
 *     defence. `accountFreeFailures` free failures, then every further
 *     attempt waits `accountBaseBlockMs × 2^(failures − free)` after the
 *     last failure, capped at `accountMaxBlockMs`. A client only ever slows
 *     down its OWN attempts on an account. A success clears the pair; a pair
 *     is forgotten `accountStateTtlMs` after its last failure. → 429.
 *     Clients that share a key share its pairs: a sender that keeps failing
 *     on one account keeps that account's pair shut for everyone on the key
 *     who has no device cookie. That is inherent — it is the same bucket.
 *     Every `device` key of one account is ONE client here, the account's
 *     known browsers: a second device id buys no second budget, and so no
 *     second share of the reserve below either.
 *  3. global  — process-wide argon2 capacity: `globalMaxInFlight`
 *     verifications at once and `globalMaxPerMinute` admitted attempts per
 *     minute (leaky bucket, so the Retry-After stays short). `device`
 *     attempts may use all of it; every other attempt stops
 *     `globalDeviceReserveInFlight` slots and `globalDeviceReservePerMinute`
 *     tokens short, so no amount of traffic from unknown browsers — however
 *     many keys it comes from — turns a known browser away. What one
 *     account's known browsers can take of the reserve is what their one
 *     pair admits. Only attempts layers 1 and 2 admitted consume it, so a
 *     flood of cheap refusals can never turn into a deployment-wide 503.
 *     → 503.
 *
 * Counting happens at ADMISSION. An admitted attempt is pending on its
 * client and pair until the caller settles it, and a pending attempt counts
 * as a failure until then: N parallel requests cannot race past the free
 * budget between the check and the verdict. Once a pair's free budget is
 * spent, it gets one attempt at a time.
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
/**
 * The pair client of every `device` key: an account's known browsers share
 * one pair. No client key equals it — device keys are `device:<id>` with a
 * 22-character id, address keys an IP address, a prefix or 'unknown'.
 */
const KNOWN_BROWSERS = 'device:*';

export type LoginLimitScope = 'client' | 'account' | 'global';

/** What the client key is — see the header comment for what each kind means. */
export type LoginClientKind = 'device' | 'address' | 'shared';

export interface LoginKeys {
  /** Who is asking: `clientAddressFor(...).key`, or `device:<id>` for a device cookie. */
  readonly clientKey: string;
  readonly clientKind: LoginClientKind;
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
  { readonly allowed: true; readonly attempt: LoginAttempt } | LoginRefusal;

export interface LoginLimiterStats {
  /** Tracked `address` keys (the only kind with client-layer state). */
  readonly clients: number;
  readonly pairs: number;
  readonly inFlight: number;
}

export interface LoginRateLimiter {
  /** Run the layers; on admission the attempt holds a global slot. */
  admit(keys: LoginKeys): LoginAdmission;
  /**
   * A bare global slot for other unauthenticated argon2 work (the first-user
   * wizard's hash), from the share of unknown browsers. Returns the release
   * function, or null when saturated.
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
  /** Of `globalMaxInFlight`, the slots only `device` attempts may take (none when it is 1). */
  readonly globalDeviceReserveInFlight: number;
  readonly globalMaxPerMinute: number;
  /** Of `globalMaxPerMinute`, the tokens only `device` attempts may take. */
  readonly globalDeviceReservePerMinute: number;
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
  globalDeviceReserveInFlight: 1,
  globalMaxPerMinute: 300,
  globalDeviceReservePerMinute: 60,
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
  return `${providerId}:${normaliseLoginAccountId(accountId) ?? '-'}`;
}

/** The account id as `loginAccountKey` keys it; undefined for a missing, empty or oversized one. */
export function normaliseLoginAccountId(accountId: string | undefined): string | undefined {
  const id = (accountId ?? '').trim().toLowerCase();
  return id.length > 0 && id.length <= MAX_ACCOUNT_ID_LENGTH ? id : undefined;
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

/** The share of the global capacity one kind of client may fill. */
interface Capacity {
  readonly inFlight: number;
  readonly perMinute: number;
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

  const knownBrowsers: Capacity = {
    inFlight: config.globalMaxInFlight,
    perMinute: config.globalMaxPerMinute,
  };
  const unknownBrowsers: Capacity = {
    inFlight: Math.max(1, config.globalMaxInFlight - config.globalDeviceReserveInFlight),
    perMinute: Math.max(1, config.globalMaxPerMinute - config.globalDeviceReservePerMinute),
  };

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

  function globalWaitMs(t: number, capacity: Capacity): number {
    if (global.inFlight >= capacity.inFlight) return SECOND;
    const excess = globalLevel(t) + 1 - capacity.perMinute;
    if (excess <= EPSILON) return 0;
    return (excess * MINUTE) / config.globalMaxPerMinute;
  }

  function refuse(
    scope: LoginLimitScope,
    clientKey: string,
    waitMs: number,
    t: number,
  ): LoginRefusal {
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

  function trackClient(key: string, existing: ClientState | undefined, t: number): ClientState {
    if (!existing) makeRoom(clients, config.maxTrackedKeys, (s) => s.pending > 0);
    const client = existing ?? { level: 0, updatedAt: t, pending: 0 };
    touch(clients, key, client);
    return client;
  }

  function trackPair(
    pairKey: string,
    accountKey: string,
    existing: PairState | undefined,
    t: number,
  ): PairState {
    if (!existing) makeRoom(pairs, config.maxTrackedKeys, (s) => s.pending > 0);
    const pair = existing ?? { accountKey, failures: 0, lastFailureAt: t, pending: 0 };
    touch(pairs, pairKey, pair);
    return pair;
  }

  function admit(keys: LoginKeys): LoginAdmission {
    const t = now();
    if (t - lastSweepAt >= config.sweepIntervalMs) sweep();

    const braked = keys.clientKind === 'address';
    const existingClient = braked ? clients.get(keys.clientKey) : undefined;
    const cWait = braked ? clientWaitMs(existingClient, t) : 0;
    if (cWait > 0) return refuse('client', keys.clientKey, cWait, t);

    const pairClient = keys.clientKind === 'device' ? KNOWN_BROWSERS : keys.clientKey;
    const pairKey = JSON.stringify([keys.accountKey, pairClient]);
    const existingPair = currentPair(pairKey, t);
    const pWait = pairWaitMs(existingPair, t);
    if (pWait > 0) return refuse('account', keys.clientKey, pWait, t);

    const capacity = keys.clientKind === 'device' ? knownBrowsers : unknownBrowsers;
    const gWait = globalWaitMs(t, capacity);
    if (gWait > 0) return refuse('global', keys.clientKey, gWait, t);

    const client = braked ? trackClient(keys.clientKey, existingClient, t) : undefined;
    const pair = trackPair(pairKey, keys.accountKey, existingPair, t);
    if (client) client.pending += 1;
    pair.pending += 1;
    const release = takeSlot(t);

    let settled = false;
    const settle = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      release();
      const at = now();
      if (client) client.pending -= 1;
      pair.pending -= 1;
      if (succeeded) {
        pair.failures = 0;
        if (pair.pending === 0 && pairs.get(pairKey) === pair) pairs.delete(pairKey);
        return;
      }
      if (client) {
        client.level = clientLevel(client, at) + 1;
        client.updatedAt = at;
      }
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
      return globalWaitMs(t, unknownBrowsers) > 0 ? null : takeSlot(t);
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
