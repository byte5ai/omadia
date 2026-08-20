'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { NavEntryDto } from '../_lib/navigation';

/**
 * Phase B (B2) — top nav with cluster dropdowns.
 *
 * The flat list grew unworkable after `/operator/agents` and the upcoming
 * `/operator/privacy` surface — clusters group related surfaces and keep
 * the bar scannable. Active-link detection still uses longest-prefix-match
 * across every leaf href so nested routes (`/store/builder` over `/store`)
 * keep working; the cluster header gets a subtle `contains-active` style
 * when any of its children matches.
 *
 * Two sources feed this bar (specs/470-dev-platform-plugin):
 *
 *   1. `NAV` below — the shell's own compiled surfaces. Labels come from
 *      the `nav.*` message catalogue, per web-ui/CLAUDE.md.
 *   2. `entries` prop — surfaces contributed by installed plugins, fetched
 *      server-side in the root layout. These carry their label as a plain
 *      string because the shell cannot know a third-party plugin's strings
 *      at build time; the middleware resolves them for the active locale
 *      before they ever reach the browser.
 *
 * (2) is the deliberate, and only, exception to "no user-facing literals
 * outside the catalogue": the string is plugin-owned data, not a hardcoded
 * literal in this file. Everything the shell itself renders still goes
 * through `useTranslations`.
 */

type NavLeaf = { readonly kind: 'link'; readonly href: string; readonly key: string };
type NavCluster = {
  readonly kind: 'cluster';
  readonly key: string;
  readonly children: readonly NavLeaf[];
};
type NavItem = NavLeaf | NavCluster;

/**
 * A leaf after merging. Static leaves resolve their label through the
 * message catalogue; plugin leaves carry a pre-resolved one.
 */
type ResolvedLeaf = {
  readonly href: string;
  readonly label: string;
};

const NAV: readonly NavItem[] = [
  { kind: 'link', href: '/', key: 'dashboard' },
  { kind: 'link', href: '/operator/skills', key: 'skills' },
  {
    kind: 'cluster',
    key: 'pluginsCluster',
    children: [
      { kind: 'link', href: '/store', key: 'store' },
      { kind: 'link', href: '/store/builder', key: 'builder' },
    ],
  },
  { kind: 'link', href: '/routines', key: 'routines' },
  { kind: 'link', href: '/chat', key: 'chat' },
  {
    kind: 'cluster',
    key: 'adminCluster',
    children: [
      { kind: 'link', href: '/admin', key: 'admin' },
      { kind: 'link', href: '/system', key: 'system' },
      // Orchestrators and Conductor moved here from the top level — they're
      // operator-facing configuration surfaces, same audience as Admin/System.
      { kind: 'link', href: '/operator/agents', key: 'agentsCluster' },
      { kind: 'link', href: '/conductor', key: 'conductor' },
      // #757 — persisted per-turn privacy receipts, same operator audience.
      { kind: 'link', href: '/operator/receipts', key: 'receipts' },
      // Dev Platform used to be hardcoded here. It is now contributed at
      // runtime (middleware registers it while DEV_PLATFORM_ENABLED), so the
      // entry disappears when the feature is off — see mergeNav below.
    ],
  },
  // OM-09 — there was NO in-product help at all: no help route, no `?`, no
  // mailto, no docs link, no search. A customer stuck on a broken provider key
  // wrote "Klingt blöd, aber ein Hilfebot wäre jetzt echt super." Top level and
  // last, so it is reachable from every page without competing for attention.
  { kind: 'link', href: '/help', key: 'help' },
] as const;

/** A static or plugin-contributed item, with its label already resolved. */
export type ResolvedNavItem =
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  | {
      readonly kind: 'cluster';
      readonly key: string;
      readonly label: string;
      readonly children: readonly ResolvedLeaf[];
    };

/**
 * Merge the shell's static nav with the plugin-contributed entries.
 *
 * Rules, in order:
 *   - A plugin entry naming an existing cluster is appended inside it.
 *   - A plugin entry with no cluster — or one naming a cluster this shell
 *     does not have — becomes a top-level entry, so a menu item is never
 *     silently swallowed by a typo or a shell/plugin version skew.
 *   - Plugin entries sort among themselves by `order`, then label. They
 *     never reorder the static items around them.
 *   - A plugin entry whose href collides with a static one is dropped.
 *     The shell's own surfaces win; a plugin must not be able to shadow
 *     a core destination with its own label.
 *
 * Pure and exported so the merge is unit-testable without a DOM.
 */
export function mergeNav(
  staticItems: readonly NavItem[],
  entries: readonly NavEntryDto[],
  translate: (key: string) => string,
): readonly ResolvedNavItem[] {
  const staticHrefs = new Set<string>();
  for (const item of staticItems) {
    if (item.kind === 'link') staticHrefs.add(item.href);
    else for (const child of item.children) staticHrefs.add(child.href);
  }

  const clusterKeys = new Set(
    staticItems.filter((i) => i.kind === 'cluster').map((i) => i.key),
  );

  const ordered = [...entries]
    .filter((e) => !staticHrefs.has(e.href))
    // Plain codepoint comparison, not localeCompare: this runs on both the
    // server and the client, and a locale-sensitive collator can order the
    // same two labels differently under Node's ICU than under the visitor's
    // browser, producing a hydration mismatch. Ties broken by pluginId +
    // navId so the order is total and stable.
    .sort(
      (a, b) =>
        a.order - b.order ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
        (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0) ||
        (a.navId < b.navId ? -1 : a.navId > b.navId ? 1 : 0),
    );

  const byCluster = new Map<string, ResolvedLeaf[]>();
  const topLevel: ResolvedLeaf[] = [];
  // Two plugins can legitimately register the same href. Rendering both
  // would duplicate the React key (`key={item.href}`) and light up two
  // entries as active. First wins, deterministically, by the sort above.
  const claimed = new Set<string>();
  for (const entry of ordered) {
    if (claimed.has(entry.href)) continue;
    claimed.add(entry.href);
    const leaf: ResolvedLeaf = { href: entry.href, label: entry.label };
    if (entry.cluster !== undefined && clusterKeys.has(entry.cluster)) {
      const bucket = byCluster.get(entry.cluster) ?? [];
      bucket.push(leaf);
      byCluster.set(entry.cluster, bucket);
    } else {
      topLevel.push(leaf);
    }
  }

  const merged: ResolvedNavItem[] = staticItems.map((item) =>
    item.kind === 'link'
      ? { kind: 'link', href: item.href, label: translate(item.key) }
      : {
          kind: 'cluster',
          key: item.key,
          label: translate(item.key),
          children: [
            ...item.children.map(
              (c): ResolvedLeaf => ({ href: c.href, label: translate(c.key) }),
            ),
            ...(byCluster.get(item.key) ?? []),
          ],
        },
  );

  return [...merged, ...topLevel.map((l) => ({ kind: 'link' as const, ...l }))];
}

function collectLeaves(items: readonly ResolvedNavItem[]): readonly ResolvedLeaf[] {
  const out: ResolvedLeaf[] = [];
  for (const item of items) {
    if (item.kind === 'link') out.push({ href: item.href, label: item.label });
    else out.push(...item.children);
  }
  return out;
}

/**
 * Longest-prefix match on *segment boundaries*. A bare `startsWith` would
 * light up `/admin` while the operator is on `/administrator`, and a plugin
 * leaf `/reports` would claim `/reports-old`.
 */
export function bestPrefixMatch(
  pathname: string | null,
  leaves: readonly ResolvedLeaf[],
): string {
  if (!pathname) return '';
  return leaves.reduce((acc, candidate) => {
    const match =
      candidate.href === '/'
        ? pathname === '/'
        : pathname === candidate.href ||
          pathname.startsWith(`${candidate.href}/`);
    if (!match) return acc;
    return candidate.href.length > acc.length ? candidate.href : acc;
  }, '');
}

export function Nav({
  entries = [],
}: {
  /** Plugin-contributed entries, fetched server-side in the root layout. */
  readonly entries?: readonly NavEntryDto[];
}): React.ReactElement {
  const pathname = usePathname();
  const t = useTranslations('nav');
  // Recomputed when entries change (plugin installed/uninstalled) — the
  // leaf set is no longer fixed at module scope.
  const items = useMemo(() => mergeNav(NAV, entries, t), [entries, t]);
  const activeHref = useMemo(
    () => bestPrefixMatch(pathname, collectLeaves(items)),
    [pathname, items],
  );
  return (
    // Tighter gap/tracking below xl so the bar stays inside the desktop
    // shell's 1100px window instead of overflowing its container (OM-30).
    // `min-w-0` lets it actually shrink — flex items default to min-width:auto.
    <nav className="flex min-w-0 items-center gap-2 text-[13px] uppercase tracking-[0.12em] xl:gap-4 xl:tracking-[0.18em]">
      {items.map((item) =>
        item.kind === 'link' ? (
          <LeafLink
            key={item.href}
            href={item.href}
            label={item.label}
            active={activeHref === item.href}
          />
        ) : (
          <ClusterDropdown
            key={item.key}
            cluster={item}
            activeHref={activeHref}
          />
        ),
      )}
    </nav>
  );
}

function LeafLink({
  href,
  label,
  active,
}: {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}): React.ReactElement {
  return (
    <Link
      href={href}
      className={[
        'relative whitespace-nowrap py-1 transition-colors',
        active
          ? 'text-[color:var(--ink)]'
          : 'text-[color:var(--muted-ink)] hover:text-[color:var(--ink)]',
      ].join(' ')}
    >
      {label}
      {active ? (
        <span className="absolute -bottom-1 left-0 h-0.5 w-full rounded-full bg-[color:var(--accent)]" />
      ) : null}
    </Link>
  );
}

/**
 * Why three states instead of one boolean (OM-20/40):
 *
 * The menu used to be a single `open` flag that `mouseenter` set to true and
 * `click` toggled. A pointer always enters the button *before* it clicks it, so
 * the click handler invariably observed `open === true` and toggled the menu
 * shut — the dropdown flicked closed at the exact moment the user tried to open
 * it, which reads as "the menu never opens".
 *
 * Splitting "open because the pointer is here" from "open because the user
 * pinned it" makes the two inputs monotonic: hover can only raise `closed →
 * hover`, click owns `pinned` exclusively, and neither can undo the other.
 */
type DropdownMode = 'closed' | 'hover' | 'pinned';

/** Grace period before a hover-opened menu closes, so travelling diagonally
 *  from the trigger toward the menu body does not dismiss it mid-move. */
const HOVER_CLOSE_GRACE_MS = 150;

function ClusterDropdown({
  cluster,
  activeHref,
}: {
  readonly cluster: Extract<ResolvedNavItem, { kind: 'cluster' }>;
  readonly activeHref: string;
}): React.ReactElement {
  const label = cluster.label;
  const [mode, setMode] = useState<DropdownMode>('closed');
  const open = mode !== 'closed';
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const containsActive = cluster.children.some(
    (child) => child.href === activeHref,
  );

  const cancelClose = useCallback((): void => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const close = useCallback((): void => {
    cancelClose();
    setMode('closed');
  }, [cancelClose]);

  /** Hover only ever *raises* the menu — it can never demote a pinned one. */
  const hoverOpen = useCallback((): void => {
    cancelClose();
    setMode((m) => (m === 'pinned' ? m : 'hover'));
  }, [cancelClose]);

  /** A hover-opened menu closes after a short grace period, so a diagonal
   *  cursor path from the button toward the menu does not dismiss it. */
  const hoverClose = useCallback((): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setMode((m) => (m === 'pinned' ? m : 'closed'));
    }, HOVER_CLOSE_GRACE_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={hoverOpen}
      onMouseLeave={hoverClose}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- menu trigger (aria-haspopup/aria-expanded), text-link styling */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        // Keyboard parity: focusing the trigger raises the menu the same way
        // hovering does, so a Tab-only user sees the children too.
        onFocus={hoverOpen}
        onClick={() => {
          cancelClose();
          setMode((m) => (m === 'pinned' ? 'closed' : 'pinned'));
        }}
        className={[
          'relative inline-flex items-center gap-1 whitespace-nowrap py-1 uppercase tracking-[0.12em] transition-colors xl:tracking-[0.18em]',
          containsActive
            ? 'text-[color:var(--ink)]'
            : 'text-[color:var(--muted-ink)] hover:text-[color:var(--ink)]',
        ].join(' ')}
      >
        {label}
        <span aria-hidden="true" className="text-[15px] leading-none">
          ▾
        </span>
        {containsActive ? (
          <span className="absolute -bottom-1 left-0 h-0.5 w-[calc(100%-12px)] rounded-full bg-[color:var(--accent)]/60" />
        ) : null}
      </button>
      {open ? (
        // Sits flush against the button (no mt-1) so the cursor never crosses
        // a dead zone on its way down; pt-1 keeps the visual gap. The menu
        // itself uses a solid surface (white in light mode, dark in dark mode)
        // because the previous `bg-[color:var(--surface)]` resolved to the
        // page background and showed page content through the menu.
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 top-full z-50 min-w-[180px] pt-1"
        >
          <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] py-1 shadow-lg">
            {cluster.children.map((child) => {
              const active = child.href === activeHref;
              return (
                <Link
                  key={child.href}
                  href={child.href}
                  role="menuitem"
                  onClick={close}
                  className={[
                    'block px-3 py-2 text-[12px] uppercase tracking-[0.16em] transition-colors',
                    active
                      ? 'bg-[color:var(--bg-soft)] text-[color:var(--ink)]'
                      : 'text-[color:var(--muted-ink)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--ink)]',
                  ].join(' ')}
                >
                  {child.label}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
