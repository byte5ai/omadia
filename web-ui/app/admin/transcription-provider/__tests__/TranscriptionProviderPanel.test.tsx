import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { TranscriptionProviderPanel } from '../_components/TranscriptionProviderPanel';
import {
  type TranscriptionProvider,
  type TranscriptionProviderState,
} from '../../../_lib/api';

const {
  mockGetState,
  mockVerify,
  mockSetKey,
  mockSelect,
} = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockVerify: vi.fn(),
  mockSetKey: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  getTranscriptionProviderState: mockGetState,
  verifyTranscriptionProvider: mockVerify,
  setTranscriptionProviderKey: mockSetKey,
  selectTranscriptionProvider: mockSelect,
  // Mirrors the real ApiError, including the OM-09 `code` parse — the panel
  // reads `err.code`, so a mock without it would test nothing.
  ApiError: class ApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        this.code = typeof parsed.code === 'string' ? parsed.code : null;
      } catch {
        this.code = null;
      }
    }
  },
}));

function provider(over: Partial<TranscriptionProvider> = {}): TranscriptionProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    pluginId: '@omadia/transcription-adapter-openai',
    active: true,
    status: 'no_key',
    connected: false,
    requiresAvvDisclosure: true,
    euHosted: false,
    models: [
      {
        id: 'openai:gpt-transcribe',
        modelId: 'gpt-transcribe',
        label: 'GPT Transcribe (Batch)',
        surfaces: ['file'],
      },
    ],
    ...over,
  };
}

function state(over: Partial<TranscriptionProviderState> = {}): TranscriptionProviderState {
  const providers = over.providers ?? [provider()];
  return {
    providers,
    active: providers.find((p) => p.active)?.id ?? null,
    vault_available: true,
    ...over,
  };
}

describe('<TranscriptionProviderPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockVerify.mockResolvedValue({ status: 'verified' });
    mockSetKey.mockResolvedValue({ ok: true, providerId: 'openai', hasKey: true });
    mockSelect.mockResolvedValue({ ok: true, active: 'openai' });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the provider with the "no key" chip and an Add-key action', async () => {
    mockGetState.mockResolvedValue(state());
    renderWithIntl(<TranscriptionProviderPanel />);

    expect(await screen.findByText('OpenAI')).toBeTruthy();
    expect(
      // Chip copy is shared with the LLM providers page (providerCredential.tsx).
      screen.getByText(en.adminProviders.providers.notConnected),
    ).toBeTruthy();
    expect(screen.getByText(/Add key/)).toBeTruthy();
    expect(screen.queryByText('Change key')).toBeNull();
    // The batch model and its surface are listed.
    expect(screen.getByText(/GPT Transcribe \(Batch\)/)).toBeTruthy();
    expect(screen.getByText(/batch \(file upload\)/)).toBeTruthy();
  });

  it('saves a pasted key through the dedicated key endpoint and auto-verifies it', async () => {
    mockGetState.mockResolvedValue(
      state({ providers: [provider({ connected: true, status: 'unverified' })] }),
    );
    renderWithIntl(<TranscriptionProviderPanel />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: 'sk-new-transcription-key' } });
    fireEvent.click(screen.getByText('Save key'));

    await waitFor(() =>
      expect(mockSetKey).toHaveBeenCalledWith('openai', 'sk-new-transcription-key'),
    );
    // A typo must be caught here, not on the next transcription tool call.
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('openai'));
  });

  it('confirms and clears the key when "Remove key" is clicked', async () => {
    mockGetState.mockResolvedValue(
      state({ providers: [provider({ connected: true, status: 'verified' })] }),
    );
    renderWithIntl(<TranscriptionProviderPanel />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockSetKey).toHaveBeenCalledWith('openai', null));
  });

  it('renders all four verdict states distinctly', async () => {
    // Verdict copy is shared with the LLM providers page (providerCredential.tsx).
    const c = en.adminProviders.providers;
    for (const [status, label] of [
      ['no_key', c.notConnected],
      ['unverified', c.unverified],
      ['verified', c.verified],
      ['invalid', c.invalid],
    ] as const) {
      mockGetState.mockResolvedValue(
        state({
          providers: [provider({ status, connected: status !== 'no_key' })],
        }),
      );
      const { unmount } = renderWithIntl(<TranscriptionProviderPanel />);
      expect(await screen.findByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('shows the AVV disclosure for the active provider when its policy requires it', async () => {
    mockGetState.mockResolvedValue(state());
    renderWithIntl(<TranscriptionProviderPanel />);

    expect(
      await screen.findByText(/data-processing agreement \(GDPR Art\. 28\)/),
    ).toBeTruthy();
  });

  it('hides the AVV disclosure when the policy opts out, and shows the EU note when hosted in the EU', async () => {
    mockGetState.mockResolvedValue(
      state({
        providers: [provider({ requiresAvvDisclosure: false, euHosted: true })],
      }),
    );
    renderWithIntl(<TranscriptionProviderPanel />);

    await screen.findByText('OpenAI');
    expect(
      screen.queryByText(/data-processing agreement \(GDPR Art\. 28\)/),
    ).toBeNull();
    expect(screen.getByText(/no third-country transfer/)).toBeTruthy();
  });

  it('activates an inactive provider via the select endpoint and reloads', async () => {
    mockGetState.mockResolvedValue(
      state({
        providers: [
          provider({ active: false }),
          provider({
            id: 'acme',
            label: 'Acme Transcribe',
            pluginId: '@acme/transcription-adapter',
            active: true,
            requiresAvvDisclosure: false,
          }),
        ],
      }),
    );
    renderWithIntl(<TranscriptionProviderPanel />);

    fireEvent.click(await screen.findByText('Activate'));

    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('openai'));
    // Reload after the switch so the ACTIVE badge moves.
    await waitFor(() => expect(mockGetState).toHaveBeenCalledTimes(2));
  });

  it('warns when no provider is active', async () => {
    mockGetState.mockResolvedValue(
      state({ providers: [provider({ active: false })] }),
    );
    renderWithIntl(<TranscriptionProviderPanel />);

    expect(
      await screen.findByText(en.adminTranscriptionProvider.selection.noneActive),
    ).toBeTruthy();
  });

  it('shows the empty-state hint when no transcription plugin is installed', async () => {
    mockGetState.mockResolvedValue(state({ providers: [], active: null }));
    renderWithIntl(<TranscriptionProviderPanel />);

    expect(
      await screen.findByText(en.adminTranscriptionProvider.noProviders),
    ).toBeTruthy();
  });

  it('renders the localized load error when the state fetch fails', async () => {
    mockGetState.mockRejectedValue(new Error('boom'));
    renderWithIntl(<TranscriptionProviderPanel />);

    expect(
      await screen.findByText(en.adminTranscriptionProvider.loadError),
    ).toBeTruthy();
  });
});
