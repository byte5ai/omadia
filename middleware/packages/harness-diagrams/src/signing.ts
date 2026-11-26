import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signing for diagram proxy URLs.
 *
 * Scheme:  `/diagrams/dl/<encoded-key>?exp=<unix-seconds>&sig=<hex>`
 * Payload: `/diagrams/dl/<key>.<exp>` — the route prefix binds a link to the route
 *          that issued it (#1979, ADR-0176): Office and Diagrams may share a
 *          secret, and revoking one route's public-path grant must not leave
 *          its files reachable through the other route.
 *
 * The secret lives in DIAGRAM_URL_SECRET and never leaves the process. Rotate
 * by setting a new value — in-flight URLs become invalid immediately.
 */

/** The route this module signs for; part of every signed payload. */
export const SIGNED_ROUTE_PREFIX = '/diagrams/dl/';

function signedPayload(key: string, exp: number): string {
  return `${SIGNED_ROUTE_PREFIX}${key}.${String(exp)}`;
}

export interface SignUrlParams {
  key: string;
  secret: string;
  ttlSec: number;
  publicBaseUrl: string;
  /** Override clock for tests; defaults to Date.now(). */
  nowSec?: number;
}

export function signUrl(params: SignUrlParams): string {
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = now + params.ttlSec;
  const sig = createHmac('sha256', params.secret)
    .update(signedPayload(params.key, exp))
    .digest('hex');
  const encKey = encodeURIComponent(params.key);
  const base = params.publicBaseUrl.replace(/\/+$/, '');
  return `${base}${SIGNED_ROUTE_PREFIX}${encKey}?exp=${String(exp)}&sig=${sig}`;
}

export interface VerifySigParams {
  key: string;
  exp: number;
  sig: string;
  secret: string;
  /** Override clock for tests; defaults to Date.now(). */
  nowSec?: number;
}

export function verifySig(params: VerifySigParams): boolean {
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(params.exp) || params.exp < now) return false;
  if (!/^[0-9a-f]+$/i.test(params.sig)) return false;
  const expected = createHmac('sha256', params.secret)
    .update(signedPayload(params.key, params.exp))
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(params.sig, 'hex');
  // timingSafeEqual throws on unequal-length buffers; pre-check.
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
