import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';
import { computeQualityScore } from '../plugins/qualityScore.js';

/**
 * Issue #52 — quality score GET surface.
 *
 *   GET /v1/builder/drafts/:id/quality
 *
 * Owner-scoped (DraftStore.load filters by user_email); 404 on
 * unreachable drafts.
 */

export interface BuilderQualityDeps {
  draftStore: DraftStore;
}

export function registerBuilderQualityRoute(
  router: Router,
  deps: BuilderQualityDeps,
): void {
  router.get('/drafts/:id/quality', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) {
      return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    }
    const draftId = readId(req);
    if (!draftId) {
      return sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });
    }
    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }
    const quality = computeQualityScore(draft.spec);
    res.json({ draftId, ...quality });
  });
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}
