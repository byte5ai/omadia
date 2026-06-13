'use client';

import { Moon, Palette, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';

/**
 * Lume palette + appearance controls (issue #282).
 *
 * Palette binds one of the three Lume accent palettes (Petrol, Atelier,
 * Lagoon — spec §2.5) to the single accent slot via `data-palette` on <html>.
 * Appearance pins light/dark (or follows the OS) via `data-theme`, which flips
 * the `color-scheme` that the token layer's `light-dark()` resolves against.
 *
 * The <html> attributes are the single source of truth: the pre-paint
 * bootstrap script in layout.tsx seeds them from localStorage before first
 * paint (no FOUC), and the selects read them via useSyncExternalStore — so
 * SSR renders the defaults and React reconciles to the real value right
 * after hydration (no suppressed-mismatch staleness).
 */

const PALETTES = ['lagoon', 'petrol', 'atelier'] as const;
type PaletteName = (typeof PALETTES)[number];

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const PALETTE_KEY = 'omadia-palette';
const THEME_KEY = 'omadia-theme';

function isPalette(v: string | null): v is PaletteName {
  return v === 'lagoon' || v === 'petrol' || v === 'atelier';
}
function isTheme(v: string | null): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
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
function readTheme(): Theme {
  const v = document.documentElement.getAttribute('data-theme');
  return isTheme(v) ? v : 'system';
}

const selectClass =
  'appearance-none rounded-md border border-[color:var(--border)] bg-transparent py-1 pl-6 pr-2 text-xs ' +
  'text-[color:var(--fg-muted)] outline-none transition-colors hover:text-[color:var(--fg-strong)] ' +
  'focus:border-[color:var(--accent)] focus-visible:border-[color:var(--accent)]';

export function ThemeControls(): React.ReactElement {
  const t = useTranslations('themeControls');
  const palette = useSyncExternalStore(subscribeToRootAttrs, readPalette, () => 'lagoon' as const);
  const theme = useSyncExternalStore(subscribeToRootAttrs, readTheme, () => 'system' as const);

  function applyPalette(next: PaletteName): void {
    const root = document.documentElement;
    // §6.6: palette changes crossfade over motion.smooth. The transient class
    // gates the typed-property transition so theme switches stay instant.
    root.classList.add('lume-xfade');
    root.setAttribute('data-palette', next);
    window.setTimeout(() => root.classList.remove('lume-xfade'), 280);
    try {
      localStorage.setItem(PALETTE_KEY, next);
    } catch {
      /* storage unavailable — selection still applies for this session */
    }
  }

  function applyTheme(next: Theme): void {
    const root = document.documentElement;
    if (next === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', next);
    }
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable */
    }
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
            <option
              key={p}
              value={p}
              className="bg-[color:var(--bg-elevated)] text-[color:var(--fg)]"
            >
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
          onChange={(e) => applyTheme(e.target.value as Theme)}
          className={selectClass}
        >
          {THEMES.map((m) => (
            <option
              key={m}
              value={m}
              className="bg-[color:var(--bg-elevated)] text-[color:var(--fg)]"
            >
              {t(`appearance.${m}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
