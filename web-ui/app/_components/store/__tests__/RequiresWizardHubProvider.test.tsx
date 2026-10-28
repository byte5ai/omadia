import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { RequiresWizard } from '../RequiresWizard';
import type {
  InstallChainResolution,
  InstallJob,
} from '../../../_lib/storeTypes';

const { mockCreate, mockConfigure, mockRegistryInstall } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConfigure: vi.fn(),
  mockRegistryInstall: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: mockCreate,
  configureInstallJob: mockConfigure,
  installFromRegistry: mockRegistryInstall,
  ApiError: class ApiError extends Error {},
}));

const CONNECTOR = '@omadia/integration-odoo';
const TARGET = '@omadia/agent-odoo-hr';

function job(pluginId: string, state: InstallJob['state']): InstallJob {
  return {
    id: `job-${pluginId}`,
    plugin_id: pluginId,
    plugin_version: '0.2.8',
    state,
    current_step: '',
    error: null,
    setup_schema: { fields: [] },
    activation_state:
      state === 'active' ? { state: 'active', ok: true, error: null, missing: [] } : null,
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
  };
}

// #1463 — the installed connector is 0.2.0 (provides nothing); the Hub's
// 0.2.1 provides the capability, so the middleware offers an update.
const resolution: InstallChainResolution = {
  unresolved_requires: ['odoo.client@^1'],
  available_providers: [
    {
      capability: 'odoo.client@^1',
      providers: [
        {
          id: CONNECTOR,
          name: 'Odoo Connector',
          kind: 'integration',
          version: '0.2.1',
          install_state: 'update-available',
          already_installed: true,
          active: false,
          source: 'registry',
          update_from: '0.2.0',
        },
      ],
    },
  ],
};

function renderWizard(): void {
  renderWithIntl(
    <RequiresWizard
      targetPluginId={TARGET}
      targetPluginName="Odoo HR Assistant"
      resolution={resolution}
      onClose={vi.fn()}
    />,
  );
}

function clickInstallAll(): void {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(en.store.requiresWizard.installAll, 'i'),
    }),
  );
}

beforeEach(() => {
  mockCreate.mockReset();
  mockConfigure.mockReset();
  mockRegistryInstall.mockReset();
});

void describe('#1463 — RequiresWizard offers the Hub update of an outdated provider', () => {
  void it('names the update and enables "Install all" instead of asking for an upload', () => {
    renderWizard();
    expect(screen.getByText('Update 0.2.0 → 0.2.1')).toBeTruthy();
    expect(screen.queryByText(en.store.requiresWizard.noProviderAvailable)).toBeNull();
    const button = screen.getByRole('button', {
      name: new RegExp(en.store.requiresWizard.installAll, 'i'),
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  void it('updates the provider from the Hub, then installs only the target', async () => {
    mockRegistryInstall.mockResolvedValueOnce({
      ok: true,
      plugin_id: CONNECTOR,
      version: '0.2.1',
      registry: 'hub',
      activated: true,
      next: { install: '' },
    });
    mockCreate.mockResolvedValueOnce({ job: job(TARGET, 'awaiting_config') });
    mockConfigure.mockResolvedValueOnce({ job: job(TARGET, 'active'), agent_id: TARGET });

    renderWizard();
    clickInstallAll();

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(en.store.requiresWizard.allInstalledDot, 'i')),
      ).toBeTruthy();
    });
    expect(mockRegistryInstall).toHaveBeenCalledWith(CONNECTOR, '0.2.1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(TARGET);
  });

  void it('stops with the activation error when the updated provider does not start', async () => {
    mockRegistryInstall.mockResolvedValueOnce({
      ok: true,
      plugin_id: CONNECTOR,
      version: '0.2.1',
      registry: 'hub',
      activation_error: 'odoo_url unreachable',
      next: { install: '' },
    });

    renderWizard();
    clickInstallAll();

    await waitFor(() => {
      expect(screen.getByText(/odoo_url unreachable/)).toBeTruthy();
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  void it('stops when the update did not start the provider (latched or stood down)', async () => {
    mockRegistryInstall.mockResolvedValueOnce({
      ok: true,
      plugin_id: CONNECTOR,
      version: '0.2.1',
      registry: 'hub',
      next: { install: '' },
    });

    renderWizard();
    clickInstallAll();

    await waitFor(() => {
      expect(screen.getByText(/updated, but not started/)).toBeTruthy();
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
