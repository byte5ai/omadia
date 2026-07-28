import { describe, expect, it } from 'vitest';

import { bestPrefixMatch, mergeNav } from '../../_components/Nav';
import type { NavEntryDto } from '../navigation';

/**
 * Merge of the shell's static nav with plugin-contributed entries
 * (specs/470-dev-platform-plugin). Pure logic — no DOM.
 */

type StaticItem = Parameters<typeof mergeNav>[0][number];

const STATIC: readonly StaticItem[] = [
  { kind: 'link', href: '/', key: 'dashboard' },
  {
    kind: 'cluster',
    key: 'adminCluster',
    children: [
      { kind: 'link', href: '/admin', key: 'admin' },
      { kind: 'link', href: '/system', key: 'system' },
    ],
  },
];

/** Stand-in for next-intl's `t` — echoes the key so assertions stay readable. */
const translate = (key: string): string => `T:${key}`;

function entry(over: Partial<NavEntryDto> = {}): NavEntryDto {
  return {
    pluginId: '@plugin/dev',
    navId: 'devPlatform',
    href: '/admin/dev-platform',
    label: 'Dev Platform',
    order: 100,
    ...over,
  };
}

describe('mergeNav', () => {
  it('renders the static nav unchanged when no plugin contributes', () => {
    const merged = mergeNav(STATIC, [], translate);
    expect(merged).toEqual([
      { kind: 'link', href: '/', label: 'T:dashboard' },
      {
        kind: 'cluster',
        key: 'adminCluster',
        label: 'T:adminCluster',
        children: [
          { href: '/admin', label: 'T:admin' },
          { href: '/system', label: 'T:system' },
        ],
      },
    ]);
  });

  it('appends a plugin entry inside the cluster it names', () => {
    const merged = mergeNav(STATIC, [entry({ cluster: 'adminCluster' })], translate);
    const cluster = merged.find((i) => i.kind === 'cluster');
    expect(cluster?.kind === 'cluster' && cluster.children).toEqual([
      { href: '/admin', label: 'T:admin' },
      { href: '/system', label: 'T:system' },
      { href: '/admin/dev-platform', label: 'Dev Platform' },
    ]);
  });

  it('uses the plugin-supplied label verbatim, not a catalogue lookup', () => {
    const merged = mergeNav(
      STATIC,
      [entry({ cluster: 'adminCluster', label: 'Dev-Plattform' })],
      translate,
    );
    const cluster = merged.find((i) => i.kind === 'cluster');
    expect(cluster?.kind === 'cluster' && cluster.children.at(-1)?.label).toBe(
      'Dev-Plattform',
    );
  });

  it('promotes a clusterless entry to top level', () => {
    const merged = mergeNav(STATIC, [entry({ href: '/reports', label: 'Reports' })], translate);
    expect(merged.at(-1)).toEqual({
      kind: 'link',
      href: '/reports',
      label: 'Reports',
    });
  });

  it('promotes an entry naming an unknown cluster rather than dropping it', () => {
    // Shell/plugin version skew must not silently swallow a menu item.
    const merged = mergeNav(
      STATIC,
      [entry({ cluster: 'clusterThatDoesNotExist' })],
      translate,
    );
    expect(merged.at(-1)).toEqual({
      kind: 'link',
      href: '/admin/dev-platform',
      label: 'Dev Platform',
    });
  });

  it('drops a plugin entry that collides with a static href', () => {
    // A plugin must not be able to shadow a core destination with its own label.
    const merged = mergeNav(
      STATIC,
      [entry({ href: '/admin', label: 'Totally Legit Admin' })],
      translate,
    );
    const labels = merged.flatMap((i) =>
      i.kind === 'cluster' ? i.children.map((c) => c.label) : [i.label],
    );
    expect(labels).not.toContain('Totally Legit Admin');
    expect(labels).toContain('T:admin');
  });

  it('sorts plugin entries by order, then label — without reordering static items', () => {
    const merged = mergeNav(
      STATIC,
      [
        entry({ navId: 'c', href: '/c', label: 'C', order: 10 }),
        entry({ navId: 'b', href: '/b', label: 'B', order: 5 }),
        entry({ navId: 'a', href: '/a', label: 'A', order: 10 }),
      ],
      translate,
    );
    expect(merged.map((i) => (i.kind === 'link' ? i.href : i.key))).toEqual([
      '/',
      'adminCluster',
      '/b',
      '/a',
      '/c',
    ]);
  });

  it('splits entries across their clusters and top level in one pass', () => {
    const merged = mergeNav(
      STATIC,
      [
        entry({ navId: 'inCluster', cluster: 'adminCluster' }),
        entry({ navId: 'topLevel', href: '/reports', label: 'Reports' }),
      ],
      translate,
    );
    const cluster = merged.find((i) => i.kind === 'cluster');
    expect(cluster?.kind === 'cluster' && cluster.children).toHaveLength(3);
    expect(merged.at(-1)).toMatchObject({ href: '/reports' });
  });
});

describe('bestPrefixMatch', () => {
  const leaves = [
    { href: '/', label: 'Dashboard' },
    { href: '/admin', label: 'Admin' },
    { href: '/admin/dev-platform', label: 'Dev Platform' },
  ];

  it('matches the root exactly, never as a prefix', () => {
    expect(bestPrefixMatch('/', leaves)).toBe('/');
    expect(bestPrefixMatch('/admin', leaves)).toBe('/admin');
  });

  it('prefers the longest matching prefix, including a plugin leaf', () => {
    expect(bestPrefixMatch('/admin/dev-platform/jobs/42', leaves)).toBe(
      '/admin/dev-platform',
    );
  });

  it('returns empty for an unmatched path and for a null pathname', () => {
    expect(bestPrefixMatch('/nowhere', leaves)).toBe('');
    expect(bestPrefixMatch(null, leaves)).toBe('');
  });

  it('stops highlighting a plugin leaf once the plugin is gone', () => {
    const withoutPlugin = leaves.filter((l) => l.href !== '/admin/dev-platform');
    expect(bestPrefixMatch('/admin/dev-platform/jobs/42', withoutPlugin)).toBe(
      '/admin',
    );
  });
});
