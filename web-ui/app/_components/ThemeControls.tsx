'use client';

import { Moon, Palette, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * Lume palette + appearance controls (issue #282).
 *
 * Palette binds one of the three Lume accent palettes (Petrol, Atelier,
 * Lagoon — spec §2.5) to the single accent slot via `data-palette` on <html>.
 * Appearance pins light/dark (or follows the OS) via `data-theme`, which flips
 * the `color-scheme` that the token layer's `light-dark()` resolves against.
 *
 * Both persist to localStorage; the pre-paint bootstrap script in layout.tsx
 * replays them before first paint so there is no flash.
 */

const PALETTES = ['lagoon', 'petrol', 'atelier'] as const;
type Palette = (typeof PALETTES)[number];

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const PALETTE_KEY = 'omadia-palette';
const THEME_KEY = 'omadia-theme';

function isPalette(v: string | null): v is Palette {
  return v === 'lagoon' || v === 'petrol' || v === 'atelier';
}
function isTheme(v: string | null): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
}

const selectClass =
  'appearance-none rounded-md border border-[color:var(--border)] bg-transparent py-1 pl-6 pr-2 text-xs ' +
  'text-[color:var(--fg-muted)] outline-none transition-colors hover:text-[color:var(--fg-strong)] ' +
  'focus:border-[color:var(--accent)] focus-visible:border-[color:var(--accent)]';

export function ThemeControls(): React.ReactElement {
  const t = useTranslations('themeControls');
  // Initialise from the attributes the pre-paint bootstrap script set on
  // <html> (client), or fall back to the defaults during SSR. The <select>s
  // carry suppressHydrationWarning so a client value differing from the SSR
  // default doesn't warn.
  const [palette, setPalette] = useState<Palette>(() => {
    if (typeof document === 'undefined') return 'lagoon';
    const p = document.documentElement.getAttribute('data-palette');
    return isPalette(p) ? p : 'lagoon';
  });
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document === 'undefined') return 'system';
    // bootstrap sets data-theme only for an explicit light/dark pin; absent => system.
    const attr = document.documentElement.getAttribute('data-theme');
    return isTheme(attr) ? attr : 'system';
  });

  function applyPalette(next: Palette): void {
    setPalette(next);
    document.documentElement.setAttribute('data-palette', next);
    try {
      localStorage.setItem(PALETTE_KEY, next);
    } catch {
      /* storage unavailable — selection still applies for this session */
    }
  }

  function applyTheme(next: Theme): void {
    setTheme(next);
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
          onChange={(e) => applyPalette(e.target.value as Palette)}
          className={selectClass}
          suppressHydrationWarning
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
          suppressHydrationWarning
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
