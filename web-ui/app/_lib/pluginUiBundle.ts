import { cache } from 'react';

import { RSC_FETCH_TIMEOUT_MS } from './api';
import { pluginUiEntryPath } from './pluginId';

/**
 * "Does this plugin ship a UI bundle?", asked server-side (#1454).
 *
 * ## Why the question needs a request at all
 *
 * Nothing in the catalog or the admin API records it. The only authority is
 * `middleware/src/routes/pluginUiStatic.ts`: it resolves the id to a package
 * root (`resolvePackageRoot`, wired in `middleware/src/index.ts` from the
 * live plugin catalog) and then looks for `ui/index.html` on disk. Both
 * halves can change without a deploy — a plugin is installed, disabled or
 * upgraded at runtime — so the honest check is to ask that handler, not to
 * mirror its two inputs here. Asking it also means there is one verdict
 * instead of two that can disagree.
 *
 * `/p/<pluginId>/ui/...` sits outside the `/api` mount and is covered by the
 * middleware's `publicPaths` allowlist, so the probe needs no session cookie
 * — and reveals nothing a browser could not already fetch from that path.
 *
 * ## Why only a 404 means "absent"
 *
 * The handler answers 404 for both cases the host page must refuse: an id the
 * catalog does not know, and an installed plugin whose package has no `ui/`
 * directory. Everything else — a 5xx, a dead socket, a timeout — says
 * something about the middleware, not about the plugin. Reporting those as
 * "no UI" would dress an outage up as a not-found page, so they resolve to
 * `true` and the frame gets its chance; if the bundle really is gone the
 * frame fails, which is the pre-#1454 behaviour rather than a new one.
 *
 * The name says `MayExist` rather than `Exists` on purpose: `false` is a
 * verdict (the handler said 404), `true` is only the absence of one.
 *
 * `HEAD` because the bytes are irrelevant here (Express serves it from the
 * same `router.get`, pinned in `middleware/test/pluginUiStaticServing.test.ts`).
 * `cache()` so `generateMetadata` and the render share one probe per request;
 * outside an RSC request React's `cache` is a pass-through, which is also
 * what keeps this unit-testable. Server-side only — it reads
 * `MIDDLEWARE_URL`, which no browser bundle has.
 */
export const pluginUiBundleMayExist: (pluginId: string) => Promise<boolean> = cache(
  async (pluginId: string): Promise<boolean> => {
    // `||`, not `??`: an env var that is present but empty (a compose file
    // with `MIDDLEWARE_URL=`) must fall back to the local default too, or
    // every probe would hit `/p/...` with no origin and throw.
    const base = process.env['MIDDLEWARE_URL'] || 'http://localhost:3979';
    // The frame's path, built by the one helper both sides share.
    const url = `${base}${pluginUiEntryPath(pluginId)}`;
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(RSC_FETCH_TIMEOUT_MS),
      });
      return res.status !== 404;
    } catch {
      return true;
    }
  },
);
