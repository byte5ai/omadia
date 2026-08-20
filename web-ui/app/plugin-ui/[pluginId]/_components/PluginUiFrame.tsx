'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

/**
 * The iframe that hosts a plugin's compiled SPA (epic #470 C8).
 *
 * WHY THE PARAMS EXIST AT ALL. An iframe is a separate document, so two
 * things the shell takes for granted silently do not cross the boundary
 * (`implementation.md` §2.3 in the epic #470 spec directory):
 *
 *   - `next/font` injects its faces into web-ui's own document only. The
 *     generated plugin stylesheet re-binds the font variables for exactly
 *     this reason.
 *   - `data-theme` / `data-palette` sit on the shell's `<html>`. Without them
 *     the plugin renders in light mode inside a shell the operator forced
 *     dark — a bug that looks like the plugin's fault.
 *
 * So the host passes `?theme=&palette=&locale=` and the plugin's `index.html`
 * mirrors them onto its own `<html>` element. Everything else — the actual
 * colours — then resolves through the one stylesheet core serves.
 *
 * The theme is read from the live DOM rather than from the cookie, and a
 * MutationObserver re-reads it, so flipping the appearance in the header
 * updates the embedded UI without a reload.
 *
 * SANDBOX — `allow-same-origin allow-scripts allow-forms`. This is a trust-
 * model decision, not a default; the reasoning is recorded in
 * `plan.md` §4.3a addendum in the epic #470 spec directory. In short:
 *
 *   - WITHOUT `allow-same-origin` the document gets an OPAQUE origin. Every
 *     `fetch('/bot-api/...')` then leaves with `Origin: null` and is a
 *     cross-site request, so the `SameSite=Lax` session cookie is not
 *     attached, `EventSource(..., { withCredentials: true })` fails the same
 *     way, and `localStorage` throws. A data-driven plugin UI opens every
 *     screen with a GET, so the sandbox did not isolate the plugin — it broke
 *     it, silently, into a correctly-themed error state.
 *   - It bought no privilege either. The plugin's server half already runs
 *     in-process in the middleware with the operator's authority. Denying its
 *     UI a session the plugin can read server-side removes function, not
 *     capability.
 *   - What still constrains the bundle is the response, not the attribute:
 *     core serves it from an ingest-scanned ZIP under a tight CSP
 *     (`default-src 'none'`, `script-src 'self'`, `connect-src 'self'`,
 *     `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'`), and
 *     the extension allowlist has no `.css`.
 *
 * `allow-popups` is deliberately GONE: nothing in a plugin UI opens a window,
 * and a capability nothing uses is only a surface.
 */

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function readPalette(): string {
  if (typeof document === 'undefined') return 'lagoon';
  return document.documentElement.getAttribute('data-palette') ?? 'lagoon';
}

export function PluginUiFrame({ pluginId }: { pluginId: string }): React.ReactElement {
  const t = useTranslations('pluginUi');
  const locale = useLocale();
  const [theme, setTheme] = useState<Theme>('light');
  const [palette, setPalette] = useState('lagoon');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const sync = (): void => {
      setTheme(readTheme());
      setPalette(readPalette());
    };
    sync();
    setMounted(true);

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  const src = useMemo(() => {
    const params = new URLSearchParams({ theme, palette, locale });
    return `/p/${encodeURIComponent(pluginId)}/ui/index.html?${params.toString()}`;
  }, [pluginId, theme, palette, locale]);

  // Rendering the iframe before the theme is known would load the bundle once
  // in the wrong appearance and again on correction. One paint, one load.
  if (!mounted) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        {t('loading')}
      </div>
    );
  }

  return (
    <iframe
      key={`${theme}-${palette}-${locale}`}
      src={src}
      title={t('frameTitle', { pluginId })}
      className="h-full w-full rounded-md border border-border bg-bg"
      sandbox="allow-same-origin allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}
