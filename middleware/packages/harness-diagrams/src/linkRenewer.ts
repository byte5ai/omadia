import type { FileLinkRenewer } from '@omadia/plugin-api';

import { isDiagramKey } from './diagramsRouter.js';
import { signUrl, verifySigIgnoringExpiry } from './signing.js';

/** The prefix this plugin registers its renewer under (no trailing slash). */
export const DIAGRAM_LINK_ROUTE_PREFIX = '/diagrams/dl';

export interface DiagramLinkRenewerOptions {
  secret: string;
  ttlSec: number;
  publicBaseUrl: string;
  /** Override clock for tests; defaults to Date.now(). */
  nowSec?: () => number;
}

/**
 * #1964 (ADR-0266): the renewer the kernel's `POST /api/v1/files/renew` calls
 * for `/diagrams/dl/…` links. Accepts only this route's signature over a
 * diagram-layout key (expiry ignored) and signs the same key again with the
 * plugin's normal TTL. The render is not repeated.
 */
export function createDiagramLinkRenewer(opts: DiagramLinkRenewerOptions): FileLinkRenewer {
  const now = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  return {
    verifyIgnoringExpiry: (link) =>
      isDiagramKey(link.key) &&
      verifySigIgnoringExpiry({ key: link.key, exp: link.exp, sig: link.sig, secret: opts.secret }),
    sign: (key) => {
      const nowSec = now();
      return {
        url: signUrl({ key, secret: opts.secret, ttlSec: opts.ttlSec, publicBaseUrl: opts.publicBaseUrl, nowSec }),
        expiresAt: nowSec + opts.ttlSec,
      };
    },
  };
}
