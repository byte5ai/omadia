import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../messages/en.json';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { ProvidersPanel } from '../ProvidersPanel';
import {
  ApiError,
  type AdminProvider,
  type ProvidersResponse,
} from '../../../../_lib/api';

/**
 * #1076 — `providers.dependent_rebuild_failed` means the assignment LANDED:
 * the server persisted the new provider and only orchestrator-extras did not
 * come back up. The row must show the new provider (the select is controlled,
 * so leaving the state alone snaps it back to the old one), surface the error
 * and offer a Retry, because re-picking the already-selected option fires no
 * change event. Any other failure keeps the old row.
 */

const { mockGetProviders, mockAssignProvider } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockAssignProvider: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getProviders: mockGetProviders,
  assignProvider: mockAssignProvider,
  patchSettings: vi.fn(),
  verifyProvider: vi.fn(),
  refreshProviderModels: vi.fn(),
  updateInstalledPluginConfig: vi.fn(),
  // Mirrors the real ApiError: `code` parsed from the body, `body` kept.
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

const ORCH = '@omadia/orchestrator';

function dependentRebuildFailure(primaryApplied: boolean): ApiError {
  return new ApiError(
    500,
    'POST /v1/admin/providers/assignment failed: 500',
    JSON.stringify({
      code: 'providers.dependent_rebuild_failed',
      message: 'extras failed to rebuild',
      dependentId: '@omadia/orchestrator-extras',
      primaryApplied,
    }),
  );
}

function model(id: string) {
  return {
    id,
    modelId: id,
    label: id,
    class: 'frontier' as const,
    contextWindow: 200_000,
    maxTokens: 8_192,
    vision: false,
  };
}

function provider(over: Partial<AdminProvider>): AdminProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    status: 'verified',
    connected: true,
    models: [model('claude-opus-4-8')],
    ...over,
  };
}

function response(): ProvidersResponse {
  return {
    providers: [
      provider({}),
      provider({ id: 'openai', label: 'OpenAI', models: [model('gpt-5.5')] }),
    ],
    assignments: [
      {
        pluginId: ORCH,
        label: 'Orchestrator',
        installed: true,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        modelKey: 'orchestrator_model',
        modelRouting: 'true',
      },
    ],
    vault_available: true,
  };
}

async function switchToOpenAi(): Promise<HTMLSelectElement> {
  renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);
  const select = (await screen.findByLabelText(
    en.adminProviders.assignments.providerLabel,
  )) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'openai' } });
  await waitFor(() => expect(mockAssignProvider).toHaveBeenCalledTimes(1));
  return select;
}

describe('<ProvidersPanel /> dependent rebuild failure (#1076)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockGetProviders.mockResolvedValue(response());
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the new provider selected and shows the dependent-rebuild copy', async () => {
    mockAssignProvider.mockRejectedValue(dependentRebuildFailure(true));
    const select = await switchToOpenAi();

    expect(
      await screen.findByText(en.errorHelp.providers.dependent_rebuild_failed.what),
    ).toBeTruthy();
    expect(screen.getByText(en.adminProviders.status.errorChip)).toBeTruthy();
    expect(select.value).toBe('openai');
    // The non-Anthropic assignment turned routing off server-side too.
    const toggle = screen.getByLabelText(
      en.adminProviders.assignments.routingLabel,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('Retry re-sends the same assignment and clears the error once it succeeds', async () => {
    mockAssignProvider
      .mockRejectedValueOnce(dependentRebuildFailure(true))
      .mockResolvedValueOnce({ ok: true });
    await switchToOpenAi();

    const retry = await screen.findByRole('button', {
      name: en.adminProviders.assignments.retryDependentRebuild,
    });
    fireEvent.click(retry);

    await waitFor(() => expect(mockAssignProvider).toHaveBeenCalledTimes(2));
    expect(mockAssignProvider.mock.calls[1]).toEqual(mockAssignProvider.mock.calls[0]);
    expect(mockAssignProvider.mock.calls[1]).toEqual([
      { pluginId: ORCH, provider: 'openai', model: 'gpt-5.5' },
    ]);
    await waitFor(() =>
      expect(screen.getByText(en.adminProviders.status.saved)).toBeTruthy(),
    );
    expect(
      screen.queryByRole('button', {
        name: en.adminProviders.assignments.retryDependentRebuild,
      }),
    ).toBeNull();
    expect(
      screen.queryByText(en.errorHelp.providers.dependent_rebuild_failed.what),
    ).toBeNull();
  });

  it('keeps the saved provider and offers Retry even when the orchestrator did not come back up', async () => {
    // The config is persisted either way; `primaryApplied: false` only says
    // the plugin itself is errored too. Snapping back would point Retry at
    // the OLD assignment.
    mockAssignProvider.mockRejectedValue(dependentRebuildFailure(false));
    const select = await switchToOpenAi();

    expect(
      await screen.findByRole('button', {
        name: en.adminProviders.assignments.retryDependentRebuild,
      }),
    ).toBeTruthy();
    expect(select.value).toBe('openai');
  });

  it('snaps back to the old provider when the assignment did not land', async () => {
    mockAssignProvider.mockRejectedValue(
      new ApiError(
        500,
        'POST /v1/admin/providers/assignment failed: 500',
        '{"code":"providers.apply_failed","message":"disk full"}',
      ),
    );
    const select = await switchToOpenAi();

    expect(
      await screen.findByText(en.errorHelp.providers.apply_failed.what),
    ).toBeTruthy();
    expect(select.value).toBe('anthropic');
    expect(
      screen.queryByRole('button', {
        name: en.adminProviders.assignments.retryDependentRebuild,
      }),
    ).toBeNull();
  });
});
