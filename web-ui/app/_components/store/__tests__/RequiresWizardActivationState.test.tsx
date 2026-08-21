import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { RequiresWizard } from '../RequiresWizard';
import type {
  InstallChainResolution,
  InstallJob,
} from '../../../_lib/storeTypes';

const { mockCreate, mockConfigure, mockRefresh } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConfigure: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: mockCreate,
  configureInstallJob: mockConfigure,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const PROVIDER_ID = '@test/provider';
const TARGET_ID = '@test/target';

function job(pluginId: string, state: InstallJob['state']): InstallJob {
  return {
    id: `job-${pluginId}`,
    plugin_id: pluginId,
    plugin_version: '0.1.0',
    state,
    current_step: '',
    error: null,
    setup_schema: { fields: [] },
    activation_state:
      state === 'errored'
        ? {
            state: 'errored',
            ok: false,
            error: 'sql permission not granted',
            missing: [{ kind: 'sql', ledger: 'plg_test_provider_migrations' }],
          }
        : state === 'active'
          ? { state: 'active', ok: true, error: null, missing: [] }
          : null,
    created_at: '2026-08-21T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
  };
}

const resolution: InstallChainResolution = {
  unresolved_requires: ['llmProvider@1'],
  available_providers: [
    {
      capability: 'llmProvider@1',
      providers: [
        {
          id: PROVIDER_ID,
          name: 'Provider Fixture',
          kind: 'integration',
          version: '0.1.0',
          install_state: 'available',
          already_installed: false,
          active: false,
        },
      ],
    },
  ],
};

function renderWizard(): void {
  renderWithIntl(
    <RequiresWizard
      targetPluginId={TARGET_ID}
      targetPluginName="Target Fixture"
      resolution={resolution}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mockCreate.mockReset();
  mockConfigure.mockReset();
  mockRefresh.mockReset();
  mockCreate
    .mockResolvedValueOnce({ job: job(PROVIDER_ID, 'awaiting_config') })
    .mockResolvedValueOnce({ job: job(TARGET_ID, 'awaiting_config') });
});

void describe('#833 review — RequiresWizard keeps chaining over errored installs', () => {
  void it('continues to the target when a dependency installed but did not activate', async () => {
    mockConfigure
      .mockResolvedValueOnce({
        job: job(PROVIDER_ID, 'errored'),
        agent_id: PROVIDER_ID,
      })
      .mockResolvedValueOnce({
        job: job(TARGET_ID, 'active'),
        agent_id: TARGET_ID,
      });

    renderWizard();

    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(en.store.requiresWizard.installAll, 'i'),
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(en.store.requiresWizard.allInstalledDot, 'i')),
      ).toBeTruthy();
    });
    expect(mockCreate).toHaveBeenNthCalledWith(1, PROVIDER_ID);
    expect(mockCreate).toHaveBeenNthCalledWith(2, TARGET_ID);
    expect(mockConfigure).toHaveBeenNthCalledWith(1, `job-${PROVIDER_ID}`, {});
    expect(mockConfigure).toHaveBeenNthCalledWith(2, `job-${TARGET_ID}`, {});
    expect(
      screen.queryByText(/ended in state .*errored/i),
    ).toBeNull();
  });
});
