import { Router } from 'express';
import type { Request, Response } from 'express';

import type { UiRouteCatalog } from '../platform/uiRouteCatalog.js';

/**
 * `GET /api/v1/ui/navigation` — the operator web UI's dynamic nav source.
 *
 * The web-ui shell ships a static nav for its own compiled surfaces and
 * merges this response for everything a plugin contributes. That split is
 * what lets a feature be *installable*: turn its plugin off and its menu
 * entry is simply absent, with no web-ui rebuild.
 *
 * Labels are resolved server-side for the requested locale. The browser
 * therefore never receives the per-locale map and never negotiates a
 * locale of its own — which keeps the shell on exactly one i18n clock
 * (next-intl's) instead of two that can drift apart on a locale switch.
 *
 * Auth: this router is mounted under `/api`, which sits behind the blanket
 * `requireAuth` gate in index.ts. Navigation reveals which features an
 * operator has installed, so it is deliberately not a public path.
 */

export interface UiNavigationRouterDeps {
  catalog: Pick<UiRouteCatalog, 'listNav'>;
  /**
   * Locales the shell can actually render. A request for anything else
   * falls back to `defaultLocale` rather than echoing an unvalidated
   * query parameter into the resolver.
   */
  supportedLocales: readonly string[];
  defaultLocale: string;
}

/**
 * Pick the locale to resolve labels against. Unknown or malformed input
 * degrades to the default — a bad `?locale=` should render English chrome,
 * never an error page in the shell's header.
 */
export function resolveRequestLocale(
  raw: unknown,
  supported: readonly string[],
  fallback: string,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (supported.includes(raw)) return raw;
  const base = raw.split('-')[0];
  if (base !== undefined && supported.includes(base)) return base;
  return fallback;
}

export function createUiNavigationRouter(
  deps: UiNavigationRouterDeps,
): Router {
  const router = Router();

  router.get('/v1/ui/navigation', (req: Request, res: Response) => {
    const locale = resolveRequestLocale(
      req.query['locale'],
      deps.supportedLocales,
      deps.defaultLocale,
    );
    // Per-session, per-locale, and invalidated by plugin activation — none
    // of which a shared cache can key on correctly. Cheap to recompute
    // (an in-memory map walk), so don't let anything cache it.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ locale, entries: deps.catalog.listNav(locale) });
  });

  return router;
}
