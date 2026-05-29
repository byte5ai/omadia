import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signing for the office-document proxy.
 *
 * Scheme:  `/documents/<encoded-key>?exp=<unix-seconds>&sig=<hex>`
 * Payload: `<key>.<exp>` (prevents replay for a different key)
 *
 * This is a deliberate copy of `@omadia/diagrams`' signing rather than a
 * reuse: that signer hard-codes the `/diagrams/` route prefix into the URL,
 * and office files must surface under `/documents/`. The HMAC scheme is
 * identical so the security properties carry over 1:1.
 *
 * The secret lives in `document_url_secret` (vault) and never leaves the
 * process. Rotate by setting a new value — in-flight URLs become invalid
 * immediately.
 */

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
    .update(`${params.key}.${String(exp)}`)
    .digest('hex');
  const encKey = encodeURIComponent(params.key);
  const base = params.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/documents/${encKey}?exp=${String(exp)}&sig=${sig}`;
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
  if (!/^[0-9a-f]+$/i.test(params.sig)) return false;
  const expected = createHmac('sha256', params.secret)
    .update(`${params.key}.${String(params.exp)}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(params.sig, 'hex');
  // timingSafeEqual throws on unequal-length buffers; pre-check.
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
