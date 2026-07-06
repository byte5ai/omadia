'use client';

import { Moon, Palette, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { getUiPrefs, putUiPrefs } from '../_lib/api';
import {
  APPEARANCES,
  PALETTES,
  UI_PREFS_COOKIE,
  isAppearance,
  isPalette,
  type Appearance,
  type PaletteName,
} from '../_lib/uiPrefs';

/**
 * Lume palette + appearance controls (issue #282, server-side store #287).
 *
 * Palette binds one of the three Lume accent palettes (Petrol, Atelier,
 * Lagoon — spec §2.5) to the single accent slot via `data-palette` on <html>.
 * Appearance pins light/dark (or follows the OS) via `data-theme`, which flips
 * the `color-scheme` that the token layer's `light-dark()` resolves against.
 *
 * The <html> attributes are the single source of truth: the RSC layout seeds
 * them from the `omadia-ui-prefs` cookie before first paint (no FOUC), and the
 * selects read them via useSyncExternalStore — so SSR renders the cookie value
 * and React reconciles after hydration (no suppressed-mismatch staleness).
 *
 * Persistence (§2.5.4): the choice lives in a per-user server store
 * (/api/v1/ui-prefs). On change we apply the attribute live, mirror it into
 * the cookie (for the next pre-paint), and PUT it to the store. On mount we
 * re-read the store to seed/correct the cookie on a fresh device.
 */

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year — a stable UI preference.

/** Mirror the choice into the non-secret cookie the RSC layout reads pre-paint.
 *  Lax + path=/ so it rides every same-site navigation; not httpOnly because
 *  it carries no secret and the client both writes and (via SSR) consumes it.
 *  `Secure` over HTTPS so it is never sent on a downgraded plain-HTTP request;
 *  omitted on http (localhost dev) where browsers reject Secure cookies. */
function writeUiPrefsCookie(palette: PaletteName, appearance: Appearance): void {
  const value = encodeURIComponent(JSON.stringify({ palette, appearance }));
  const secure = window.location.protocol === 'https:' ? ';secure' : '';
  document.cookie = `${UI_PREFS_COOKIE}=${value};path=/;max-age=${COOKIE_MAX_AGE};samesite=lax${secure}`;
}

/** Re-render whenever the <html> theme attributes change. */
function subscribeToRootAttrs(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-palette', 'data-theme'],
  });
  return () => observer.disconnect();
}

function readPalette(): PaletteName {
  const v = document.documentElement.getAttribute('data-palette');
  return isPalette(v) ? v : 'lagoon';
}
function readTheme(): Appearance {
  const v = document.documentElement.getAttribute('data-theme');
  return isAppearance(v) ? v : 'system';
}

const selectClass =
  'appearance-none rounded-md border border-[color:var(--border)] bg-transparent py-1 pl-6 pr-2 text-xs ' +
  'text-[color:var(--fg-muted)] outline-none transition-colors hover:text-[color:var(--fg-strong)] ' +
  'focus:border-[color:var(--accent)] focus-visible:border-[color:var(--accent)]';

export function ThemeControls(): React.ReactElement {
  const t = useTranslations('themeControls');
  const palette = useSyncExternalStore(subscribeToRootAttrs, readPalette, () => 'lagoon' as const);
  const theme = useSyncExternalStore(subscribeToRootAttrs, readTheme, () => 'system' as const);

  // Guards the mount hydration against a race: if the user picks a palette/
  // appearance before the in-flight GET resolves, the stale server value must
  // NOT clobber their fresh choice. Set on the first user change; checked when
  // the GET lands. A ref (not state) so it never triggers a re-render.
  const userTouched = useRef(false);

  // Hydrate from the server store on mount: the cookie/SSR value may be stale
  // (or absent on a fresh device). Apply the stored choice to <html> — the
  // MutationObserver re-renders the selects — and refresh the cookie so the
  // next pre-paint on this device matches. No PUT here: the store is already
  // the source. Stays silent when logged out / offline (cookie value holds),
  // or when the user has already made a choice this session (their PUT wins).
  useEffect(() => {
    let cancelled = false;
    void getUiPrefs()
      .then((p) => {
        if (cancelled || userTouched.current) return;
        const root = document.documentElement;
        const nextPalette = isPalette(p.palette) ? p.palette : readPalette();
        const nextTheme = isAppearance(p.appearance) ? p.appearance : readTheme();
        if (nextPalette !== readPalette()) root.setAttribute('data-palette', nextPalette);
        if (nextTheme === 'system') root.removeAttribute('data-theme');
        else if (nextTheme !== readTheme()) root.setAttribute('data-theme', nextTheme);
        writeUiPrefsCookie(nextPalette, nextTheme);
      })
      .catch(() => {
        /* unauthenticated / offline — keep the cookie-seeded values */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Mirror the current choice into the cookie + per-user server store. */
  function persist(nextPalette: PaletteName, nextTheme: Appearance): void {
    userTouched.current = true;
    writeUiPrefsCookie(nextPalette, nextTheme);
    void putUiPrefs({ palette: nextPalette, appearance: nextTheme }).catch(() => {
      /* Best-effort cross-device sync. On a network/5xx error the cookie + live
       * attribute already applied, so the choice holds for this session. A 401
       * is the exception: putUiPrefs → maybeNavigateToLogin bounces to /login
       * before this catch runs (the session is dead, re-auth is required). */
    });
  }

  function applyPalette(next: PaletteName): void {
    const root = document.documentElement;
    // §6.6: palette changes crossfade over motion.smooth. The transient class
    // gates the typed-property transition so theme switches stay instant.
    root.classList.add('lume-xfade');
    root.setAttribute('data-palette', next);
    window.setTimeout(() => root.classList.remove('lume-xfade'), 280);
    persist(next, readTheme());
  }

  function applyTheme(next: Appearance): void {
    const root = document.documentElement;
    if (next === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', next);
    }
    persist(readPalette(), next);
  }

  return (
    <div className="flex items-center gap-2">
      <label className="relative inline-flex items-center" aria-label={t('paletteAriaLabel')}>
        <Palette
          className="pointer-events-none absolute left-1.5 h-3.5 w-3.5 text-[color:var(--fg-subtle)]"
          aria-hidden
        />
        <select
          value={palette}
          onChange={(e) => applyPalette(e.target.value as PaletteName)}
          className={selectClass}
        >
          {PALETTES.map((p) => (
            <option key={p} value={p}>
              {t(`palette.${p}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="relative inline-flex items-center" aria-label={t('appearanceAriaLabel')}>
        {theme === 'dark' ? (
          <Moon
            className="pointer-events-none absolute left-1.5 h-3.5 w-3.5 text-[color:var(--fg-subtle)]"
            aria-hidden
          />
        ) : (
          <Sun
            className="pointer-events-none absolute left-1.5 h-3.5 w-3.5 text-[color:var(--fg-subtle)]"
            aria-hidden
          />
        )}
        <select
          value={theme}
          onChange={(e) => applyTheme(e.target.value as Appearance)}
          className={selectClass}
        >
          {APPEARANCES.map((m) => (
            <option key={m} value={m}>
              {t(`appearance.${m}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
