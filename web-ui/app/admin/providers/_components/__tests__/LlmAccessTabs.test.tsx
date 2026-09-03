import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { LlmAccessTabs } from '../LlmAccessTabs';

const { mockGetProviders, mockGetCliBackends } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockGetCliBackends: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getProviders: mockGetProviders,
  assignProvider: vi.fn(),
  patchSettings: vi.fn(),
  verifyProvider: vi.fn(),
  getCliBackends: mockGetCliBackends,
  startCliLogin: vi.fn(),
  submitCliLoginCode: vi.fn(),
  cancelCliLogin: vi.fn(),
  cliLogout: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body?: string,
    ) {
      super(message);
    }
  },
}));

/**
 * Regression guard for OM-05/38.
 *
 * The Subscriptions panel pointed back at the API-keys panel with a
 * `<Link href="/admin/providers?tab=providers">` — but it is already *on*
 * `/admin/providers`, and `LlmAccessTabs` seeds its tab state from
 * `initialTab` exactly once on mount. Same route ⇒ no remount ⇒ clicking the
 * link reloaded the page onto the very tab the operator was trying to leave.
 * Both directions must now be in-page state switches.
 */
describe('<LlmAccessTabs /> cross-panel navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviders.mockResolvedValue({
      // A `toolLess` provider is the subscription CLI — its row carries the
      // "Log in →" control that jumps to the Subscriptions tab.
      providers: [
        {
          id: 'cli',
          label: 'Claude CLI',
          status: 'no_key',
          connected: false,
          models: [],
          toolLess: true,
        },
      ],
      assignments: [],
      vault_available: true,
    });
    mockGetCliBackends.mockResolvedValue({ backends: [] });
  });

  it('switches from the Subscriptions panel to the API-keys panel', async () => {
    renderWithIntl(<LlmAccessTabs initialTab="subscriptions" />);

    // The subscriptions panel is up: its own loader ran, the providers one did not.
    await waitFor(() => {
      expect(mockGetCliBackends).toHaveBeenCalled();
    });
    expect(mockGetProviders).not.toHaveBeenCalled();

    // OM-79 (#994): the explainer link is now an instruction ("assign the
    // orchestrator to this CLI under LLM access"), no longer an aside about
    // selecting a model. It is still the in-page switch to the API-keys panel.
    const switchControl = screen.getByRole('button', {
      name: /assign the orchestrator to this CLI/i,
    });
    fireEvent.click(switchControl);

    // Switching must happen in-page (state), not by navigating to the same URL.
    await waitFor(() => {
      expect(mockGetProviders).toHaveBeenCalled();
    });
    const providersTab = screen.getByRole('tab', { name: /api key/i });
    expect(providersTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switches from the API-keys panel back to the Subscriptions panel', async () => {
    renderWithIntl(<LlmAccessTabs initialTab="providers" />);

    await waitFor(() => {
      expect(mockGetProviders).toHaveBeenCalled();
    });
    expect(mockGetCliBackends).not.toHaveBeenCalled();

    const switchControl = await screen.findByRole('button', { name: /log in/i });
    fireEvent.click(switchControl);

    await waitFor(() => {
      expect(mockGetCliBackends).toHaveBeenCalled();
    });
    const subscriptionsTab = screen.getByRole('tab', { name: /subscriptions/i });
    expect(subscriptionsTab.getAttribute('aria-selected')).toBe('true');
  });
});
