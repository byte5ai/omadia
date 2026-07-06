import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ProvidersPanel } from '../ProvidersPanel';
import type { AdminProvider, ProvidersResponse } from '../../../../_lib/api';

const { mockGetProviders, mockAssignProvider, mockPatchSettings } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockAssignProvider: vi.fn(),
  mockPatchSettings: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getProviders: mockGetProviders,
  assignProvider: mockAssignProvider,
  patchSettings: mockPatchSettings,
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

function provider(over: Partial<AdminProvider> = {}): AdminProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    connected: false,
    models: [],
    ...over,
  };
}

function providersResponse(over: Partial<ProvidersResponse> = {}): ProvidersResponse {
  return {
    providers: [provider()],
    assignments: [],
    vault_available: true,
    ...over,
  };
}

describe('<ProvidersPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows "Add key" (not "Change key"/"Remove key") for a provider with no key', async () => {
    mockGetProviders.mockResolvedValue(providersResponse());
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(/Add key/)).toBeTruthy();
    expect(screen.queryByText('Change key')).toBeNull();
    expect(screen.queryByText('Remove key')).toBeNull();
  });

  it('shows "Change key" and "Remove key" (not "Add key") for a connected provider — regression guard for #402', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({ providers: [provider({ connected: true })] }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(/Change key/)).toBeTruthy();
    expect(screen.getByText('Remove key')).toBeTruthy();
    expect(screen.queryByText(/Add key/)).toBeNull();
  });

  it('opens the key input and PATCHes the new key when "Change key" is clicked', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({ providers: [provider({ connected: true })] }),
    );
    mockPatchSettings.mockResolvedValue({ updated: [], errors: [] });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: 'sk-ant-new-value' } });
    fireEvent.click(screen.getByText('Save key'));

    await waitFor(() =>
      expect(mockPatchSettings).toHaveBeenCalledWith([
        { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-new-value' },
      ]),
    );
  });

  it('confirms and PATCHes a clearing value when "Remove key" is clicked', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({ providers: [provider({ connected: true })] }),
    );
    mockPatchSettings.mockResolvedValue({ updated: [], errors: [] });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(mockPatchSettings).toHaveBeenCalledWith([
        { key: 'ANTHROPIC_API_KEY', value: null },
      ]),
    );
  });

  it('surfaces an error when removing the key fails (no silent destructive failure)', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({ providers: [provider({ connected: true })] }),
    );
    mockPatchSettings.mockResolvedValue({
      updated: [],
      errors: [{ key: 'ANTHROPIC_API_KEY', message: 'vault offline' }],
    });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(await screen.findByText('vault offline')).toBeTruthy();
  });

  it('does not PATCH when the remove confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mockGetProviders.mockResolvedValue(
      providersResponse({ providers: [provider({ connected: true })] }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(confirm).toHaveBeenCalled();
    expect(mockPatchSettings).not.toHaveBeenCalled();
  });
});
