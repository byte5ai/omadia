import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import type { ProfileSummary } from '../../../_lib/profileTypes';
import { OnboardingModal } from '../OnboardingModal';

/**
 * #1484 — the shipped profile cards render catalog copy in the UI language
 * (the YAML descriptions were half German, half English), a custom profile
 * keeps its own description, and the apply outcome says that the plugins only
 * become active after a restart and why a provider was skipped.
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

const PROFILES = [
  {
    id: 'blank',
    name: 'Blank Slate',
    description: 'Leeres Profil. … per /store/upload',
    plugin_count: 0,
  },
  {
    id: 'team-custom',
    name: 'Team Custom',
    description: 'Our own stack.',
    plugin_count: 1,
  },
] as ProfileSummary[];

afterEach(() => {
  cleanup();
});

describe('OnboardingModal profiles (#1484)', () => {
  it('renders shipped profiles from the catalog and custom ones as written', () => {
    renderWithIntl(<OnboardingModal operatorInstalledCount={0} profiles={PROFILES} />);
    expect(screen.getByText(en.onboarding.profiles.blank)).toBeTruthy();
    expect(screen.queryByText(/store\/upload/)).toBeNull();
    expect(screen.getByText('Our own stack.')).toBeTruthy();
  });

  it('says a restart activates the plugins and why a provider was skipped', async () => {
    mockApplyProfile.mockResolvedValue({
      profile_id: 'team-custom',
      installed: [{ id: '@omadia/verifier', version: '0.1.0' }],
      skipped: [
        {
          id: '@omadia/memory',
          reason: 'capability_provided',
          capability: 'memoryStore@1',
          owner_id: '@omadia/memory-postgres',
          message: "'memoryStore@1' is already provided by @omadia/memory-postgres",
        },
      ],
      errored: [],
    });
    renderWithIntl(<OnboardingModal operatorInstalledCount={0} profiles={PROFILES} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[1]!);

    expect(await screen.findByText(en.onboarding.restartHint)).toBeTruthy();
    expect(
      screen.getByText(
        en.onboarding.skippedCapabilityProvided
          .replace('{capability}', 'memoryStore@1')
          .replace('{owner}', '@omadia/memory-postgres')
          .trim(),
      ),
    ).toBeTruthy();
  });
});
