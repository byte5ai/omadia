import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import { HARNESS_ADMIN_CSS } from '../admin-ui/harness-admin-css.js';

/**
 * Harness Admin-UI shared assets. Today: a single baseline stylesheet that
 * plugin-bundled admin UIs `<link>` into their HTML so they inherit byte5
 * tokens, typography, and form styling without each plugin re-implementing
 * it. See docs/harness-platform/PLAN-admin-ui-theming.md.
 *
 * Mounted at `/api/_harness` from middleware/src/index.ts. Plugins reach
 * the asset through the web-dev rewrite at `/bot-api/_harness/admin-ui.css`.
 *
 * No auth: stylesheet is public, content has no operator-specific data.
 */
export function createHarnessAdminUiRouter(): Router {
  const router = Router();
  const etag = `"${createHash('sha256')
    .update(HARNESS_ADMIN_CSS)
    .digest('hex')
    .slice(0, 16)}"`;

  router.get('/admin-ui.css', (req: Request, res: Response) => {
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
    res.send(HARNESS_ADMIN_CSS);
  });

  return router;
}
