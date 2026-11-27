import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signing for the office-document proxy.
 *
 * Scheme:  `/documents/dl/<encoded-key>?exp=<unix-seconds>&sig=<hex>`
 * Payload: `/documents/dl/<key>.<exp>` — the route prefix binds a link to the route
 *          that issued it (#1979, ADR-0176): Office and Diagrams may share a
 *          secret, and revoking one route's public-path grant must not leave
 *          its files reachable through the other route.
 *
 * This is a deliberate copy of `@omadia/diagrams`' signing rather than a
 * reuse: that signer hard-codes the `/diagrams/` route prefix into the URL,
 * and office files must surface under `/documents/`. The HMAC scheme is
 * the same apart from the route prefix in the payload.
 *
 * The secret lives in `document_url_secret` (vault) and never leaves the
 * process. Rotate by setting a new value — in-flight URLs become invalid
 * immediately.
 */

/** The route this module signs for; part of every signed payload. */
export const SIGNED_ROUTE_PREFIX = '/documents/dl/';

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

export function signDocumentUrl(params: SignUrlParams): string {
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

export function verifyDocumentSig(params: VerifySigParams): boolean {
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(params.exp) || params.exp < now) return false;
  return signatureMatches(params);
}

/**
 * #1964 (ADR-0266): the signature check alone, expiry ignored. Only the
 * kernel's renew route uses it (through the link renewer), and that route
 * applies its own maximum age.
 */
export function verifyDocumentSigIgnoringExpiry(params: Omit<VerifySigParams, 'nowSec'>): boolean {
  if (!Number.isFinite(params.exp)) return false;
  return signatureMatches(params);
}

function signatureMatches(params: Omit<VerifySigParams, 'nowSec'>): boolean {
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
