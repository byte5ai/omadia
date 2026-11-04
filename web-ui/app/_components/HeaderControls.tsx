'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { NavEntryDto } from '../_lib/navigation';
import { AuthBadge } from './AuthBadge';
import { CreateIssueButton } from './CreateIssueButton';
import { LocaleFlagMenu, LocaleSwitcher } from './LocaleSwitcher';
import { Nav } from './Nav';
import {
  AppearanceSelect,
  AppearanceToggle,
  PaletteSelect,
  useThemePrefs,
  type ThemePrefs,
} from './ThemeControls';

/** The auth UI itself — always rendered with the signed-out bar. */
function isAuthPage(pathname: string | null): boolean {
  return pathname === '/login' || pathname === '/setup';
}

/**
 * Right-hand side of the app header. Two shapes:
 *
 *   - Signed in: nav · user chip · GitHub issue button. Palette, appearance
 *     and language live in the user chip's menu instead of the bar.
 *   - Signed out (and always on /login + /setup): no nav — every entry would
 *     only bounce back to /login — just a language flag menu, a sun/moon
 *     toggle and the GitHub issue button.
 *
 * The issue button is last in both shapes, pinned to the far right.
 *
 * `signedIn` is decided server-side from the session cookie so the first
 * paint already has the right shape; the pathname check covers a still-fresh
 * cookie on /login (e.g. `?reauth=1`).
 */
export function HeaderControls({
  signedIn,
  navEntries,
}: {
  readonly signedIn: boolean;
  readonly navEntries: readonly NavEntryDto[];
}): React.ReactElement {
  const pathname = usePathname();
  // Mounted here, not inside the user menu: the store hydration must run on
  // page load, not only while the menu is open.
  const prefs = useThemePrefs();

  if (!signedIn || isAuthPage(pathname)) {
    return (
      <div className="ml-auto flex items-center gap-1">
        <LocaleFlagMenu />
        <AppearanceToggle theme={prefs.theme} onTheme={prefs.applyTheme} />
        <span className="mx-1 h-5 w-px bg-[color:var(--border)]" aria-hidden />
        <CreateIssueButton />
      </div>
    );
  }

  return (
    // The row fits by construction, not by shrinking: the preferences moved
    // into the user menu, the auth badge drops the first name below xl, and
    // the wide gap only starts at 2xl (#1073, OM-30). No `min-w-0` — the
    // nowrap nav cannot shrink, so it would spill over the controls instead
    // of overflowing at the edge.
    <div className="ml-auto flex items-center gap-2 2xl:gap-4">
      <Nav entries={navEntries} />
      <span className="hidden h-5 w-px bg-[color:var(--border)] sm:block" aria-hidden />
      <AuthBadge preferences={<UserPreferences prefs={prefs} />} />
      <CreateIssueButton />
    </div>
  );
}

/** Palette, appearance and language rows for the user menu. */
function UserPreferences({ prefs }: { readonly prefs: ThemePrefs }): React.ReactElement {
  const t = useTranslations('authBadge');
  const rowClass = 'flex items-center justify-between gap-3 text-xs text-[color:var(--fg-muted)]';
  return (
    <div className="flex flex-col gap-2">
      <div className={rowClass}>
        <span>{t('palette')}</span>
        <PaletteSelect palette={prefs.palette} onPalette={prefs.applyPalette} />
      </div>
      <div className={rowClass}>
        <span>{t('appearance')}</span>
        <AppearanceSelect theme={prefs.theme} onTheme={prefs.applyTheme} />
      </div>
      <div className={rowClass}>
        <span>{t('language')}</span>
        <LocaleSwitcher />
      </div>
    </div>
  );
}
