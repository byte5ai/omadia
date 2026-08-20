import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Router, type Request, type Response } from 'express';

/**
 * Static serving for a plugin's compiled SPA bundle (epic #470 C8 / G7).
 *
 * A distributed plugin ships its UI as a `ui/` directory inside its package
 * ZIP — `ui/index.html` plus hashed JS and assets. Core serves that directory
 * read-only at
 *
 *   GET /p/<pluginId>/ui/            → ui/index.html
 *   GET /p/<pluginId>/ui/<path>      → ui/<path>
 *
 * i.e. under the plugin's own `/p/<pluginId>` prefix, so nav entries, the
 * `publicPaths` entry and the web-ui `/p/*` proxy all keep working unchanged.
 * The router is mounted at `/p` by core and passes every non-`/ui` request
 * through with `next()`, so a plugin's own Express router still owns the rest
 * of its prefix.
 *
 * WHY CORE SERVES THIS AND NOT THE PLUGIN. The plugin contract has no static
 * middleware, and handing plugins `express.static` would put the traversal,
 * content-type and caching decisions in thirty repositories instead of one.
 * It also keeps the rule that makes the Tailwind vocabulary enforceable: this
 * handler serves an extension allowlist that contains no `.css`, so even a
 * plugin that smuggled a stylesheet past the ZIP extractor could not get it
 * served.
 *
 * SECURITY PROPERTIES, each covered by a test in
 * `test/pluginUiStaticServing.test.ts`:
 *
 *   - No traversal. The URL path is decoded, rejected if it still contains a
 *     `..` segment or a NUL, resolved, and then re-checked for containment
 *     inside `<packageRoot>/ui` — belt and braces, because `path.resolve`
 *     normalising `..` away is exactly what makes the naive check pass.
 *   - No directory listing and no directory fallthrough: a request that
 *     resolves to a directory is a 404, except the bundle root which serves
 *     `index.html`.
 *   - No symlink escape: the resolved real path is containment-checked too,
 *     so a symlink that survived extraction cannot point out of the bundle.
 *     (The extractor rejects symlinks; this does not rely on that.)
 *   - Extension allowlist, and the `Content-Type` comes from that same table
 *     rather than from sniffing, with `X-Content-Type-Options: nosniff`.
 *   - `Content-Security-Policy` on `index.html` confines the document: no
 *     inline script beyond its own bootstrap hash-free `script-src 'self'`,
 *     stylesheets only from core, `frame-ancestors 'self'` so it can be
 *     iframed by the shell and by nobody else.
 *
 * CACHING. A file whose basename carries a build hash (`app-4f2a9c1e.js`)
 * gets `immutable, max-age=1y`; everything else, `index.html` above all, gets
 * `no-cache` with an ETag, so an upgrade is visible on the next reload.
 */

/** Extension → Content-Type. Deliberately no `.css` — see the header. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/** The directory inside a package root that holds the bundle. */
export const UI_BUNDLE_DIR = 'ui';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

/**
 * `name-<hash>.ext` where the candidate hash is 8+ base36-ish characters and
 * contains at least one digit. The safe failure direction is "revalidate" for
 * an unusual hash, not "freeze an ordinary dashed filename for a year".
 */
const HASHED_BASENAME = /-(?=[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$)(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]+\.[A-Za-z0-9]+$/;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * SVG is served as an image asset, not as an interactive document. A stricter
 * policy than the HTML shell is therefore correct, and the safe failure
 * direction is to make a directly navigated SVG inert rather than same-origin.
 */
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export interface PluginUiStaticOptions {
  /**
   * Resolves a plugin id to its package root (the directory holding
   * `manifest.yaml`), or `undefined` when the id is unknown. Injected so the
   * router does not reach into the catalog, the uploaded store and the
   * built-in store itself.
   */
  resolvePackageRoot(pluginId: string): string | undefined;
}

export function createPluginUiStaticRouter(
  options: PluginUiStaticOptions,
): Router {
  // `mergeParams` is irrelevant here; the router owns both params itself.
  const router = Router();

  router.get('/:pluginId/ui', (req, res) => {
    void serve(options, req, res, 'index.html');
  });
  router.get('/:pluginId/ui/{*assetPath}', (req, res) => {
    const raw = req.params['assetPath'];
    const joined = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    void serve(options, req, res, joined === '' ? 'index.html' : joined);
  });

  return router;
}

async function serve(
  options: PluginUiStaticOptions,
  req: Request,
  res: Response,
  rawRelative: string,
): Promise<void> {
  const rawId = req.params['pluginId'];
  const pluginId = typeof rawId === 'string' ? rawId : '';
  const packageRoot = options.resolvePackageRoot(pluginId);
  if (!packageRoot) {
    res.status(404).json({ error: 'plugin_ui_not_found' });
    return;
  }

  const relative = safeRelativePath(rawRelative);
  if (relative === null) {
    res.status(400).json({ error: 'plugin_ui_bad_path' });
    return;
  }

  const bundleRoot = path.resolve(packageRoot, UI_BUNDLE_DIR);
  const abs = path.resolve(bundleRoot, relative);
  if (!isContained(bundleRoot, abs)) {
    res.status(400).json({ error: 'plugin_ui_bad_path' });
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) {
    // No listing, no sniffing, no `.css`: an extension we do not name is
    // indistinguishable from a file that is not there.
    res.status(404).json({ error: 'plugin_ui_not_found' });
    return;
  }

  let body: Buffer;
  let realPath: string;
  try {
    // realpath first: a symlink that survived extraction must not escape.
    // The ROOT is realpath'd too, or every containment check fails wherever
    // the packages directory itself sits behind a symlink — /var → /private/var
    // on macOS, /tmp likewise on several distros. Comparing a resolved path
    // against an unresolved root is the classic false negative here.
    realPath = await fs.realpath(abs);
    const realRoot = await fs.realpath(bundleRoot);
    if (!isContained(realRoot, realPath)) {
      res.status(400).json({ error: 'plugin_ui_bad_path' });
      return;
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      res.status(404).json({ error: 'plugin_ui_not_found' });
      return;
    }
    body = await fs.readFile(realPath);
  } catch {
    res.status(404).json({ error: 'plugin_ui_not_found' });
    return;
  }

  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
  const hashed = HASHED_BASENAME.test(path.basename(abs));
  const responseCsp = ext === '.svg' ? IMAGE_CSP : CSP;

  res.set('Content-Type', contentType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', hashed ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
  res.set('ETag', etag);
  res.set('Content-Security-Policy', responseCsp);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.send(body);
}

/**
 * Decode and validate one URL path. Returns `null` for anything that must not
 * reach the filesystem. Kept separate (and exported) so the traversal tests
 * can hit it directly as well as through the router.
 */
export function safeRelativePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Windows separators would survive `path.posix` reasoning on a POSIX host
  // and be a separator on a Windows one — normalise before judging.
  const normalised = decoded.replace(/\\/g, '/');
  if (normalised.startsWith('/')) return null;
  const segments = normalised.split('/');
  for (const segment of segments) {
    if (segment === '..') return null;
  }
  return segments.filter((s) => s !== '' && s !== '.').join('/');
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
