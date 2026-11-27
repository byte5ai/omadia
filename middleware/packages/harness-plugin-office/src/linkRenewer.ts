import type { FileLinkRenewer } from '@omadia/plugin-api';

import { isDocumentKey } from './documentsRouter.js';
import { signDocumentUrl, verifyDocumentSigIgnoringExpiry } from './signing.js';

/** The prefix this plugin registers its renewer under (no trailing slash). */
export const DOCUMENT_LINK_ROUTE_PREFIX = '/documents/dl';

export interface DocumentLinkRenewerOptions {
  secret: string;
  ttlSec: number;
  publicBaseUrl: string;
  /** Override clock for tests; defaults to Date.now(). */
  nowSec?: () => number;
}

/**
 * #1964 (ADR-0266): the renewer the kernel's `POST /api/v1/files/renew` calls
 * for `/documents/dl/…` links. Accepts only this route's signature over an
 * Office-layout key (expiry ignored) and signs the same key again with the
 * plugin's normal TTL. The file is not generated again.
 */
export function createDocumentLinkRenewer(opts: DocumentLinkRenewerOptions): FileLinkRenewer {
  const now = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  return {
    verifyIgnoringExpiry: (link) =>
      isDocumentKey(link.key) &&
      verifyDocumentSigIgnoringExpiry({ key: link.key, exp: link.exp, sig: link.sig, secret: opts.secret }),
    sign: (key) => {
      const nowSec = now();
      return {
        url: signDocumentUrl({ key, secret: opts.secret, ttlSec: opts.ttlSec, publicBaseUrl: opts.publicBaseUrl, nowSec }),
        expiresAt: nowSec + opts.ttlSec,
      };
    },
  };
}
