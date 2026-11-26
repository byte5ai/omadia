/**
 * Per-client brake on wrong `ADMIN_TOKEN` bearers (`adminTokenMount.ts`).
 *
 * The surface compared every bearer it got, as often as a client cared to
 * send one. This is the password limiter's client layer
 * (`loginRateLimiter.ts`, layer 1) for the token: a leaky bucket of FAILURES
 * per client. A full bucket answers 429 with `Retry-After` before the token
 * is compared, so a client that keeps guessing learns nothing more until a
 * drain step opens. A right token never fills it.
 *
 * Like the password layer it applies only to an address a trusted proxy
 * vouched for (`AUTH_LOGIN_CLIENT_ADDRESS` = `xff:<n>` / `header:<name>`; Fly
 * sets `header:Fly-Client-IP`). The shared TCP peer skips it: one sender
 * filling that bucket would lock every operator out of the break-glass
 * surface. In-memory, per process; a restart empties it.
 */
import type { Request } from 'express';

import { clientAddressFor, type ClientAddressPolicy } from '../auth/clientAddress.js';

/** Burst of wrong tokens one client may send before it waits. */
export const ADMIN_TOKEN_MAX_FAILURES = 10;
/** The bucket drains {@link ADMIN_TOKEN_MAX_FAILURES} failures per window. */
export const ADMIN_TOKEN_FAILURE_WINDOW_MS = 60_000;
/**
 * Below this length a token on an unbraked surface is guessable enough to
 * warn about: 32 characters of hex or base64 is 128 bits or more.
 */
export const ADMIN_TOKEN_MIN_UNBRAKED_LENGTH = 32;
/** Distinct clients tracked at once; the least recently failed go first. */
const MAX_TRACKED_CLIENTS = 10_000;

export interface AdminTokenThrottleOptions {
  readonly clientAddress: ClientAddressPolicy;
  readonly ipv6PrefixBits?: number;
  readonly now?: () => number;
}

export interface AdminTokenThrottle {
  /** Milliseconds this request's client must wait, or 0 when it may try. */
  retryAfterMs(req: Pick<Request, 'socket' | 'headers'>): number;
  /** A wrong token from this request's client. */
  recordFailure(req: Pick<Request, 'socket' | 'headers'>): void;
}

interface Bucket {
  /** Failures still in the bucket at {@link at}. */
  level: number;
  /** The drain mark: steps count from here, so a failure keeps a partial step. */
  at: number;
}

export function createAdminTokenThrottle(opts: AdminTokenThrottleOptions): AdminTokenThrottle {
  const now = opts.now ?? Date.now;
  const drainMs = ADMIN_TOKEN_FAILURE_WINDOW_MS / ADMIN_TOKEN_MAX_FAILURES;
  // Insertion order = last failure order: a failure re-inserts its key.
  const buckets = new Map<string, Bucket>();

  /** The vouched client key, or undefined for the shared TCP peer. */
  const keyOf = (req: Pick<Request, 'socket' | 'headers'>): string | undefined => {
    const client = clientAddressFor(req, opts.clientAddress, opts.ipv6PrefixBits);
    return client.shared ? undefined : client.key;
  };

  /** Whole drain steps since the bucket's last drain mark. */
  const stepsSince = (bucket: Bucket, t: number): number => Math.floor((t - bucket.at) / drainMs);

  /** The bucket's level now, after the drain since its last drain mark. */
  const levelAt = (bucket: Bucket, t: number): number => Math.max(0, bucket.level - stepsSince(bucket, t));

  return {
    retryAfterMs(req) {
      const key = keyOf(req);
      const bucket = key === undefined ? undefined : buckets.get(key);
      if (!bucket) return 0;
      const t = now();
      if (levelAt(bucket, t) < ADMIN_TOKEN_MAX_FAILURES) return 0;
      // Full: the next drain step frees one try.
      return Math.max(1, drainMs - ((t - bucket.at) % drainMs));
    },
    recordFailure(req) {
      const key = keyOf(req);
      if (key === undefined) return;
      const t = now();
      const previous = buckets.get(key);
      const drained = previous ? levelAt(previous, t) : 0;
      // Advance the mark by the whole steps drained only: a failure must not
      // throw away the partial step towards the next drain.
      const at = previous && drained > 0 ? previous.at + stepsSince(previous, t) * drainMs : t;
      buckets.delete(key);
      buckets.set(key, { level: Math.min(drained + 1, ADMIN_TOKEN_MAX_FAILURES), at });
      if (buckets.size > MAX_TRACKED_CLIENTS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    },
  };
}

/**
 * Boot-time lines for an ADMIN_TOKEN the throttle cannot protect. With
 * `AUTH_LOGIN_CLIENT_ADDRESS=socket` every request comes from the shared TCP
 * peer, which is never braked (see the file comment), so the token's length
 * is the only defence. That stays the accepted trade-off; the operator is told
 * once at boot instead of finding out from the security docs. Empty for no
 * token or a vouched client address.
 */
export function adminTokenThrottleWarnings(
  token: string | undefined,
  clientAddress: ClientAddressPolicy,
): string[] {
  const value = token?.trim() ?? '';
  if (value === '' || clientAddress.kind !== 'socket') return [];
  const warnings = [
    '[admin-token] wrong tokens are not braked: AUTH_LOGIN_CLIENT_ADDRESS=socket keys every client as the shared TCP peer. Set it to xff:<n> or header:<name> behind a proxy (Fly: header:Fly-Client-IP).',
  ];
  if (value.length < ADMIN_TOKEN_MIN_UNBRAKED_LENGTH) {
    warnings.push(
      `[admin-token] ADMIN_TOKEN is shorter than ${String(ADMIN_TOKEN_MIN_UNBRAKED_LENGTH)} characters while unbraked; use a long random token (openssl rand -hex 32).`,
    );
  }
  return warnings;
}
