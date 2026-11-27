import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

import '../auth/requireAuth.js';
import type { FileLinkRenewalRegistry } from '../services/fileLinkRenewal.js';

/**
 * ADR-0266 (#1964) — `POST /api/v1/files/renew`.
 *
 * Body `{ url }`: a signed download link of Office (`/documents/dl/…`) or
 * Diagrams (`/diagrams/dl/…`), typically expired. Answers `{ url, expiresAt }`
 * with a link freshly signed for the same key, without re-generating the file.
 *
 * Rule (generated files are bound to no conversation, ADR-0178):
 *   1. a signed-in session (mounted behind `requireAuth`, re-checked here),
 *   2. the producer's renewer accepts the signature with the expiry ignored,
 *   3. the original expiry is at most `maxAgeSec` in the past.
 *
 * Refusals are logged with a hashed key id only, never the URL or signature.
 */

/** Links whose expiry lies further back than this are not renewed. */
export const FILE_LINK_RENEW_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const MAX_URL_LENGTH = 4096;
/** Base for parsing a relative link; its origin is never used. */
const PARSE_BASE = 'http://renew.invalid';

export type FileLinkRenewRefusal =
  | 'bad_request'
  | 'session_required'
  | 'unknown_route'
  | 'invalid_signature'
  | 'too_old';

const REFUSAL_STATUS: Record<FileLinkRenewRefusal, number> = {
  bad_request: 400,
  session_required: 401,
  unknown_route: 404,
  invalid_signature: 403,
  too_old: 410,
};

const REFUSAL_MESSAGE: Record<FileLinkRenewRefusal, string> = {
  bad_request: 'body must be { url } with a signed download link',
  session_required: 'sign in to renew a file link',
  unknown_route: 'no installed plugin renews links of this kind',
  invalid_signature: 'the link was not signed by this installation',
  too_old: 'the link is too old to renew; ask for the file again',
};

export interface FileLinkRenewDeps {
  readonly registry: FileLinkRenewalRegistry;
  /** Defaults to {@link FILE_LINK_RENEW_MAX_AGE_SEC}. */
  readonly maxAgeSec?: number;
  /** Clock override for tests (unix seconds). */
  readonly nowSec?: () => number;
  readonly log?: (line: string) => void;
}

interface ParsedLink {
  readonly pathname: string;
  readonly exp: number;
  readonly sig: string;
}

function parseLink(raw: unknown): ParsedLink | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return undefined;
  }
  const expRaw = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!/^\d{1,12}$/.test(expRaw) || !/^[0-9a-f]{1,128}$/i.test(sig)) return undefined;
  return { pathname: url.pathname, exp: Number(expRaw), sig };
}

function decodeKey(encodedKey: string): string | undefined {
  try {
    const key = decodeURIComponent(encodedKey);
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Short, non-reversible id of a storage key for logs (keys carry file names). */
export function keyLogId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function createFileLinkRenewRouter(deps: FileLinkRenewDeps): Router {
  const router = Router();
  const maxAgeSec = deps.maxAgeSec ?? FILE_LINK_RENEW_MAX_AGE_SEC;
  const now = deps.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((line: string): void => console.warn(line));

  router.post('/renew', (req: Request, res: Response) => {
    const refuse = (reason: FileLinkRenewRefusal, context: { route?: string; key?: string } = {}): void => {
      const parts = [
        `reason=${reason}`,
        ...(context.route ? [`route=${context.route}`] : []),
        ...(context.key ? [`key=${keyLogId(context.key)}`] : []),
        ...(req.session?.omadia_user_id ? [`user=${req.session.omadia_user_id}`] : []),
      ];
      log(`[file-links] renew refused: ${parts.join(' ')}`);
      res.status(REFUSAL_STATUS[reason]).json({
        code: `file_link.${reason}`,
        message: REFUSAL_MESSAGE[reason],
      });
    };

    if (!req.session) {
      refuse('session_required');
      return;
    }
    const body = req.body as { url?: unknown } | undefined;
    const link = parseLink(body?.url);
    if (!link) {
      refuse('bad_request');
      return;
    }
    const resolved = deps.registry.resolve(link.pathname);
    if (!resolved) {
      refuse('unknown_route');
      return;
    }
    const key = decodeKey(resolved.encodedKey);
    if (!key) {
      refuse('bad_request', { route: resolved.routePrefix });
      return;
    }
    const context = { route: resolved.routePrefix, key };
    if (!resolved.renewer.verifyIgnoringExpiry({ key, exp: link.exp, sig: link.sig })) {
      refuse('invalid_signature', context);
      return;
    }
    if (link.exp < now() - maxAgeSec) {
      refuse('too_old', context);
      return;
    }
    try {
      const renewed = resolved.renewer.sign(key);
      res.status(200).json({ url: renewed.url, expiresAt: renewed.expiresAt });
    } catch (err) {
      log(`[file-links] renew failed: route=${resolved.routePrefix} key=${keyLogId(key)} error=${err instanceof Error ? err.name : 'unknown'}`);
      res.status(500).json({ code: 'file_link.renew_failed', message: 'the link could not be renewed' });
    }
  });

  return router;
}
