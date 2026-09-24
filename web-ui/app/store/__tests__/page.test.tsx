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

vi.mock('../../_lib/authRedirect', () => ({
  redirectIfUnauthorized: vi.fn(),
}));

import { OnboardingModal } from '../../_components/onboarding/OnboardingModal';
import StorePage from '../page';

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
