import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plugin } from '../../_lib/storeTypes';
import type { ProfileSummary } from '../../_lib/profileTypes';

/**
 * #1089 — the store page decides which count the profile modal sees.
 *
 * The modal's own tests feed it a count computed in the test, so they stay
 * green when the page passes the plain installed count again — which is 16 on
 * a fresh Compose deploy and makes the modal unreachable. This pins the
 * wiring: the prop StorePage hands to OnboardingModal.
 *
 * The page tree holds async server components (tabs, empty/error states), so
 * the returned element is inspected rather than rendered.
 */

const { mockListStorePlugins, mockListProfiles } = vi.hoisted(() => ({
  mockListStorePlugins: vi.fn(),
  mockListProfiles: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string): string => key,
}));

vi.mock('../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/api')>()),
  listStorePlugins: mockListStorePlugins,
  listProfiles: mockListProfiles,
}));

vi.mock('../../_lib/appVersion', () => ({ APP_VERSION: 'v9.9.9' }));

vi.mock('../../_lib/authRedirect', () => ({
  redirectIfUnauthorized: vi.fn(),
}));

import { OnboardingModal } from '../../_components/onboarding/OnboardingModal';
import StorePage from '../(index)/page';

interface ModalProps {
  operatorInstalledCount: number;
}

/** Props of every OnboardingModal element in the tree StorePage returns. */
function modalProps(node: ReactNode): ModalProps[] {
  if (Array.isArray(node)) return node.flatMap(modalProps);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const here =
    node.type === OnboardingModal ? [node.props as unknown as ModalProps] : [];
  return [...here, ...modalProps(node.props.children)];
}

function storePlugin(
  id: string,
  install_origin: Plugin['install_origin'],
): Plugin {
  const over: Partial<Plugin> = { install_origin };
  return {
    id,
    kind: 'tool',
    name: id,
    version: '1.0.0',
    latest_version: '1.0.0',
    description: '',
    categories: [],
    integrations_summary: [],
    install_state: 'installed',
    ...over,
  } as Plugin;
}

const PROFILES: ProfileSummary[] = [
  {
    id: 'minimal-dev',
    name: 'Minimal Dev',
    description: 'A small set to get going.',
    plugin_count: 2,
  } as ProfileSummary,
];

async function renderedModals(): Promise<ModalProps[]> {
  return modalProps(await StorePage({ searchParams: Promise.resolve({}) }));
}

describe('store page — profile modal wiring (#1089)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListProfiles.mockResolvedValue({ items: PROFILES });
  });

  it('passes 0 when only bundled built-ins are installed', async () => {
    mockListStorePlugins.mockResolvedValue({
      items: [
        storePlugin('@omadia/memory-postgres', 'bundled'),
        storePlugin('@omadia/orchestrator', 'bundled'),
        storePlugin('@omadia/verifier', 'bundled'),
      ],
    });
    const modals = await renderedModals();
    expect(modals).toHaveLength(1);
    expect(modals[0]?.operatorInstalledCount).toBe(0);
  });

  it('counts the operator install and only that one', async () => {
    mockListStorePlugins.mockResolvedValue({
      items: [
        storePlugin('@omadia/memory-postgres', 'bundled'),
        storePlugin('@omadia/orchestrator', 'bundled'),
        storePlugin('@acme/crm', 'operator'),
      ],
    });
    const modals = await renderedModals();
    expect(modals[0]?.operatorInstalledCount).toBe(1);
  });

  it('does not offer the first-run modal when the plugin list failed to load', async () => {
    // An empty list from a failed request reads as "0 operator installs";
    // over an established deployment that would claim nothing is installed.
    mockListStorePlugins.mockRejectedValue(new Error('upstream 502'));
    expect(await renderedModals()).toEqual([]);
  });
});

/** Plain text of the first <footer> in the tree StorePage returns. */
function footerText(node: ReactNode, inFooter = false): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return inFooter ? String(node) : '';
  }
  if (Array.isArray(node)) return node.map((n) => footerText(n, inFooter)).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return footerText(node.props.children, inFooter || node.type === 'footer');
}

describe('store page — footer (#1383)', () => {
  it('shows the running build instead of a literal v1', async () => {
    mockListProfiles.mockResolvedValue({ items: PROFILES });
    mockListStorePlugins.mockResolvedValue({ items: [] });
    const text = footerText(await StorePage({ searchParams: Promise.resolve({}) }));
    expect(text).toContain('omadia · v9.9.9');
    expect(text).not.toContain('docs/harness-platform/examples');
    expect(text).toContain('footerSourceValue');
  });
});

/** Every element in the tree (async server components stay unrendered). */
function allElements(
  node: ReactNode,
): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    { type: node.type, props: node.props as Record<string, unknown> },
    ...allElements(node.props.children),
  ];
}

function sourceTabProps(node: ReactNode): Record<string, unknown> {
  const tabs = allElements(node).find(
    (el) => typeof el.type === 'function' && el.type.name === 'SourceTabs',
  );
  if (!tabs) throw new Error('SourceTabs not rendered');
  return tabs.props;
}

const HUB_SOURCE = {
  registry: 'omadia-public',
  download_url: 'https://hub.test/x.zip',
  sha256: 'a'.repeat(64),
};

function catalogPlugin(id: string, over: Partial<Plugin>): Plugin {
  return { ...storePlugin(id, 'operator'), ...over } as Plugin;
}

describe('store page — tabs, pills and search (#1469, #1470, #1471)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListProfiles.mockResolvedValue({ items: [] });
  });

  it('counts an installed hub plugin once, under Installed (#1469)', async () => {
    const items = [
      catalogPlugin('@a/installed-from-hub', { install_state: 'installed', source: HUB_SOURCE }),
      catalogPlugin('@a/update', { install_state: 'update-available', source: HUB_SOURCE }),
      catalogPlugin('@a/hub-only', { install_state: 'available', source: HUB_SOURCE }),
      catalogPlugin('@a/upload', { install_state: 'available' }),
    ];
    mockListStorePlugins.mockResolvedValue({ items });
    const props = sourceTabProps(await StorePage({ searchParams: Promise.resolve({}) }));
    expect(props).toMatchObject({ hubCount: 1, localCount: 1, installedCount: 2 });
    expect(
      (props.hubCount as number) +
        (props.localCount as number) +
        (props.installedCount as number),
    ).toBe(items.length);
  });

  it('renders a pill for every plugin kind and highlights ?kind=extension (#1470)', async () => {
    mockListStorePlugins.mockResolvedValue({
      items: [catalogPlugin('@a/llm', { kind: 'extension', install_state: 'available' })],
    });
    const tree = await StorePage({
      searchParams: Promise.resolve({ source: 'local', kind: 'extension' }),
    });
    const pills = allElements(tree)
      .map((el) => el.props.href)
      .filter((href): href is string => typeof href === 'string' && href.includes('kind='));
    expect(pills).toEqual(
      expect.arrayContaining([
        '/store?source=local&kind=tool',
        '/store?source=local&kind=extension',
      ]),
    );
    const active = allElements(tree).find(
      (el) => el.props.href === '/store?source=local&kind=extension',
    );
    expect(active?.props['aria-current']).toBe('page');
  });

  it('passes ?q to the API and keeps it in every tab and pill link (#1471)', async () => {
    mockListStorePlugins.mockResolvedValue({ items: [] });
    const tree = await StorePage({
      searchParams: Promise.resolve({ q: '  odoo  ', source: 'installed' }),
    });
    expect(mockListStorePlugins).toHaveBeenCalledWith({ search: 'odoo' });
    expect(sourceTabProps(tree).query).toBe('odoo');
    const pillHrefs = allElements(tree)
      .map((el) => el.props.href)
      .filter((href): href is string => typeof href === 'string' && href.includes('kind='));
    expect(pillHrefs.length).toBeGreaterThan(0);
    for (const href of pillHrefs) expect(href).toContain('q=odoo');
    const input = allElements(tree).find((el) => el.props.name === 'q');
    expect(input?.props.defaultValue).toBe('odoo');
  });

  it('lists without a search parameter when ?q is absent', async () => {
    mockListStorePlugins.mockResolvedValue({ items: [] });
    await StorePage({ searchParams: Promise.resolve({}) });
    expect(mockListStorePlugins).toHaveBeenCalledWith({});
  });
});
