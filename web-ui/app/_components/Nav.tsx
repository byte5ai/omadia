'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

const TABS: Array<{ href: string; key: string }> = [
  { href: '/', key: 'chat' },
  { href: '/store', key: 'store' },
  { href: '/store/builder', key: 'builder' },
  { href: '/memory', key: 'memory' },
  { href: '/graph', key: 'graph' },
  { href: '/routines', key: 'routines' },
  { href: '/admin', key: 'admin' },
  { href: '/system', key: 'system' },
];

export function Nav(): React.ReactElement {
  const pathname = usePathname();
  const t = useTranslations('nav');
  return (
    <nav className="flex items-center gap-5 text-[13px] uppercase tracking-[0.18em]">
      {TABS.map((tab) => {
        // Nested routes (/store/builder) must win over their parent (/store)
        // when both are in the nav — otherwise `startsWith` picks the parent
        // too. Matching the longest prefix resolves that.
        const best = TABS.reduce((acc, candidate) => {
          const match =
            candidate.href === '/'
              ? pathname === '/'
              : pathname?.startsWith(candidate.href) ?? false;
          if (!match) return acc;
          return candidate.href.length > acc.length ? candidate.href : acc;
        }, '');
        const active = best === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              'relative py-1 transition-colors',
              active
                ? 'text-[color:var(--ink)]'
                : 'text-[color:var(--muted-ink)] hover:text-[color:var(--ink)]',
            ].join(' ')}
          >
            {t(tab.key)}
            {active ? (
              <span className="absolute -bottom-1 left-0 h-0.5 w-full rounded-full bg-[color:var(--accent)]" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
