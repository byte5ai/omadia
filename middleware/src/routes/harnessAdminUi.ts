import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Router, type Request, type Response } from 'express';

import { ASSETS } from '../platform/assets.js';

/**
 * Shared assets for plugin-authored UI surfaces.
 *
 *   GET /api/_harness/plugin-ui.css            the design-system stylesheet
 *   GET /api/_harness/admin-ui.css             legacy alias for the same bytes
 *   GET /api/_harness/plugin-ui/fonts/<file>   `@font-face` sources, if any
 *
 * Browsers reach these through the web-ui proxy at `/bot-api/_harness/...`.
 *
 * Epic #470 C8. Until this change the stylesheet was
 * `src/admin-ui/harness-admin-css.ts` — 345 hand-written lines whose own
 * header asked the next maintainer to "keep the two roughly in sync when the
 * design system changes". It is now generated from `web-ui/app/_lib/theme.css`
 * plus the shared `_lib/tailwind-bridge.css` by
 * `web-ui/scripts/build-plugin-ui-css.mjs`, committed to
 * `middleware/assets/plugin-ui/plugin-ui.css`, and diffed in CI. The sync
 * obligation is gone rather than restated.
 *
 * `admin-ui.css` stays as an alias because shipped plugin admin UIs (and the
 * boilerplate template) already `<link>` it; the generated sheet carries the
 * same `.harness-*` helper classes, now token-driven.
 *
 * The file is read once at construction and held in memory: it is ~70 KB and
 * changes only on deploy. A missing file is a boot failure, not a runtime
 * 404 — `ASSETS.pluginUi` is part of `verifyAssetBundles()`.
 *
 * No auth: the stylesheet and fonts carry no operator-specific data, and the
 * plugin surfaces that link them are themselves unauthenticated documents.
 */

const STYLESHEET_FILE = 'plugin-ui.css';
const FONTS_DIR = 'fonts';
/** Fonts are content-hashed by nobody, so cache modestly and revalidate. */
const FONT_CACHE_CONTROL = 'public, max-age=86400, must-revalidate';
const CSS_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

export interface HarnessAdminUiRouterOptions {
  /** Override the asset root. Tests point this at a fixture directory. */
  assetsRoot?: string;
}

export async function createHarnessAdminUiRouter(
  options: HarnessAdminUiRouterOptions = {},
): Promise<Router> {
  const root = options.assetsRoot ?? ASSETS.pluginUi.root;
  const css = await fs.readFile(path.join(root, STYLESHEET_FILE), 'utf-8');
  const etag = `"${createHash('sha256').update(css).digest('hex').slice(0, 16)}"`;

  const router = Router();

  const serveCss = (req: Request, res: Response): void => {
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('ETag', etag);
    res.set('Cache-Control', CSS_CACHE_CONTROL);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(css);
  };

  router.get(`/${STYLESHEET_FILE}`, serveCss);
  // Legacy alias — shipped plugin admin UIs link this path.
  router.get('/admin-ui.css', serveCss);

  router.get('/plugin-ui/fonts/:file', (req: Request, res: Response) => {
    void serveFont(root, req, res);
  });

  return router;
}

/**
 * Font files are addressed by bare basename. `:file` cannot contain a `/`
 * (Express never matches one into a single param) but it CAN contain `..`,
 * so containment is re-checked after resolution rather than assumed.
 */
async function serveFont(
  root: string,
  req: Request,
  res: Response,
): Promise<void> {
  const raw = req.params['file'];
  const name = typeof raw === 'string' ? raw : '';
  if (!/^[A-Za-z0-9._-]+\.woff2$/.test(name) || name.includes('..')) {
    res.status(404).end();
    return;
  }
  const fontsRoot = path.resolve(root, FONTS_DIR);
  const abs = path.resolve(fontsRoot, name);
  if (!abs.startsWith(fontsRoot + path.sep)) {
    res.status(404).end();
    return;
  }
  let body: Buffer;
  try {
    body = await fs.readFile(abs);
  } catch {
    res.status(404).end();
    return;
  }
  res.set('Content-Type', 'font/woff2');
  res.set('Cache-Control', FONT_CACHE_CONTROL);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(body);
}
