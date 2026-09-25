import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { Plugin } from '../../../_lib/storeTypes';
import type { ProfileSummary } from '../../../_lib/profileTypes';
import { isOperatorInstalled } from '../../../_lib/pluginCounts';
import { OnboardingModal } from '../OnboardingModal';

/**
 * #1089 — the "Profil wählen" modal was unreachable in the default install.
 *
 * It gated on `installedCount < 3`, sized against a boot that seeded "one or
 * two leaf-tools". Today's bootstrap auto-installs 16 packages, so the store
 * opened straight into the plugin list on every Docker Compose deployment and
 * the curated-profile path — the documented "productive in under 60 seconds"
 * route — never ran for a real operator.
 *
 * The count the modal receives is now the OPERATOR count, so these tests feed
 * it through the same predicate the store page uses rather than hand-picking a
 * number. They cannot see which count the store page actually passes; that
 * wiring is pinned in app/store/__tests__/page.test.tsx.
 */

const { mockApplyProfile } = vi.hoisted(() => ({
  mockApplyProfile: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: (): { refresh: () => void } => ({ refresh: (): void => {} }),
}));

vi.mock('../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/api')>()),
  applyProfile: mockApplyProfile,
}));

function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: '@omadia/memory',
    kind: 'tool',
    name: 'Memory',
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

/** The 16 packages a fresh Compose boot auto-installs, in miniature. */
const BUILT_INS = [
  plugin({ id: '@omadia/memory', install_origin: 'bundled' }),
  plugin({ id: '@omadia/embeddings', install_origin: 'bundled' }),
  plugin({ id: '@omadia/orchestrator', install_origin: 'bundled' }),
  plugin({ id: '@omadia/verifier', install_origin: 'bundled' }),
];

function renderModal(plugins: Plugin[]): void {
  renderWithIntl(
    <OnboardingModal
      operatorInstalledCount={plugins.filter(isOperatorInstalled).length}
      profiles={PROFILES}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('OnboardingModal (#1089)', () => {
  it('shows on a fresh system that only has bundled built-ins', () => {
    renderModal(BUILT_INS);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Minimal Dev')).toBeTruthy();
  });

  it('stays hidden once the operator has installed one plugin', () => {
    renderModal([
      ...BUILT_INS,
      plugin({ id: '@acme/crm', install_origin: 'operator' }),
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays hidden against a middleware that reports no origin at all', () => {
    // Version skew: the field is absent, so every installed plugin counts.
    // Deliberately NOT the pre-#1089 behaviour — the old `< 3` gate showed the
    // modal for a single install, `=== 0` hides it.
    renderModal([plugin({ id: '@omadia/memory' })]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when the server offered no profiles', () => {
    renderWithIntl(
      <OnboardingModal operatorInstalledCount={0} profiles={[]} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the apply outcome visible after the refresh raises the count', async () => {
    // The apply installs or promotes plugins, so the router.refresh() that
    // follows delivers a count of at least 1. The outcome — above all its
    // errored entries — must survive that re-render until the operator closes.
    mockApplyProfile.mockResolvedValue({
      profile_id: 'minimal-dev',
      installed: [{ id: '@omadia/embeddings', version: '1.0.0' }],
      skipped: [],
      errored: [
        {
          id: 'de.byte5.channel.teams',
          reason: 'not_in_catalog',
          message: 'not in the catalog',
        },
      ],
    });
    const { rerender } = renderWithIntl(
      <OnboardingModal operatorInstalledCount={0} profiles={PROFILES} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('de.byte5.channel.teams')).toBeTruthy();

    rerender(<OnboardingModal operatorInstalledCount={1} profiles={PROFILES} />);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('de.byte5.channel.teams')).toBeTruthy();
  });
});
