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
 * SANDBOX. `allow-scripts allow-forms allow-popups` and NOT
 * `allow-same-origin`: the bundle is third-party code and this keeps it out
 * of the operator's cookies and localStorage on our origin. A plugin needing
 * authenticated calls does them from its own backend router, which is where
 * its authentication lives anyway.
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
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}
