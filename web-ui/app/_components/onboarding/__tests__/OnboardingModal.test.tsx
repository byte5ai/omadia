import { cleanup, screen } from '@testing-library/react';
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
 * number: a fixture that passed `0` directly would pass over a store page that
 * still counts built-ins.
 */

vi.mock('next/navigation', () => ({
  useRouter: (): { refresh: () => void } => ({ refresh: (): void => {} }),
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
    // Version skew: the field is absent, so every installed plugin counts and
    // the modal behaves exactly as it did before #1089.
    renderModal([plugin({ id: '@omadia/memory' })]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when the server offered no profiles', () => {
    renderWithIntl(
      <OnboardingModal operatorInstalledCount={0} profiles={[]} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
