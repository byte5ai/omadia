'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * Phase B (B2) — top nav with cluster dropdowns.
 *
 * The flat list grew unworkable after `/operator/agents` and the upcoming
 * `/operator/privacy` surface — clusters group related surfaces and keep
 * the bar scannable. Active-link detection still uses longest-prefix-match
 * across every leaf href so nested routes (`/store/builder` over `/store`)
 * keep working; the cluster header gets a subtle `contains-active` style
 * when any of its children matches.
 */

type NavLeaf = { readonly kind: 'link'; readonly href: string; readonly key: string };
type NavCluster = {
  readonly kind: 'cluster';
  readonly key: string;
  readonly children: readonly NavLeaf[];
};
type NavItem = NavLeaf | NavCluster;

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
    ],
  },
] as const;

function collectLeaves(items: readonly NavItem[]): readonly NavLeaf[] {
  const out: NavLeaf[] = [];
  for (const item of items) {
    if (item.kind === 'link') out.push(item);
    else out.push(...item.children);
  }
  return out;
}

const ALL_LEAVES = collectLeaves(NAV);

function bestPrefixMatch(pathname: string | null): string {
  if (!pathname) return '';
  return ALL_LEAVES.reduce((acc, candidate) => {
    const match =
      candidate.href === '/'
        ? pathname === '/'
        : pathname.startsWith(candidate.href);
    if (!match) return acc;
    return candidate.href.length > acc.length ? candidate.href : acc;
  }, '');
}

export function Nav(): React.ReactElement {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const activeHref = bestPrefixMatch(pathname);
  return (
    <nav className="flex items-center gap-4 text-[13px] uppercase tracking-[0.18em]">
      {NAV.map((item) =>
        item.kind === 'link' ? (
          <LeafLink
            key={item.href}
            href={item.href}
            label={t(item.key)}
            active={activeHref === item.href}
          />
        ) : (
          <ClusterDropdown
            key={item.key}
            cluster={item}
            label={t(item.key)}
            renderChildLabel={(child) => t(child.key)}
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
        'relative py-1 transition-colors',
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

function ClusterDropdown({
  cluster,
  label,
  renderChildLabel,
  activeHref,
}: {
  readonly cluster: NavCluster;
  readonly label: string;
  readonly renderChildLabel: (child: NavLeaf) => string;
  readonly activeHref: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const containsActive = cluster.children.some(
    (child) => child.href === activeHref,
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className={[
          'relative inline-flex items-center gap-1 py-1 transition-colors uppercase tracking-[0.18em]',
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
                  onClick={() => setOpen(false)}
                  className={[
                    'block px-3 py-2 text-[12px] uppercase tracking-[0.16em] transition-colors',
                    active
                      ? 'bg-[color:var(--bg-soft)] text-[color:var(--ink)]'
                      : 'text-[color:var(--muted-ink)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--ink)]',
                  ].join(' ')}
                >
                  {renderChildLabel(child)}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
