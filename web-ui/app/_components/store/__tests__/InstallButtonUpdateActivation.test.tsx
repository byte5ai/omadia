import { fireEvent, screen, waitFor, type RenderResult } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';

/**
 * #1452 — the update button must not report a dead plugin as updated.
 *
 * `doUpdate` re-ingests the newer version and then only calls
 * `router.refresh()`. When the activation of the new version fails, the
 * middleware now answers the ingest with `activation_error` (and has flipped
 * the registry entry to `errored`) — before that the failure lived in one log
 * line, the response said `ok: true`, and the operator who clicked "Update"
 * was shown nothing at all.
 *
 * Two things are pinned: the error is named, and a clean update still shows no
 * error — without the second, "always show an error" would pass.
 */

const { mockInstallFromRegistry, mockRefresh } = vi.hoisted(() => ({
  mockInstallFromRegistry: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: vi.fn(),
  configureInstallJob: vi.fn(),
  getPluginGrants: vi.fn().mockResolvedValue(null),
  deleteUploadedPackage: vi.fn(),
  getInstalledPlugin: vi.fn().mockResolvedValue(null),
  getPrivacyPosture: vi.fn(async () => ({
    shield_active: true,
    force_guarded: false,
    provider_ids: [],
  })),
  installFromRegistry: mockInstallFromRegistry,
  uninstallPlugin: vi.fn(),
  updateInstalledPluginConfig: vi.fn(),
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

const PLUGIN = '@test/update-activation';
const ACTIVATION_ERROR =
  "plugin '@test/update-activation' called ctx.services.get('entityRefBus') but its manifest does not declare that capability";

function button(installState: 'update-available' | 'installed'): React.ReactElement {
  return (
    <InstallButton
      pluginId={PLUGIN}
      pluginName="Update Activation Fixture"
      installState={installState}
      enabled
      blockingReasons={[]}
      installedVersion="0.2.0"
      {...(installState === 'update-available' ? { availableVersion: '0.2.1' } : {})}
      remote
    />
  );
}

function renderUpdatable(): RenderResult {
  return renderWithIntl(button('update-available'));
}

function clickUpdate(): void {
  // Exact name: the page also carries the "Update available" banner text.
  fireEvent.click(screen.getByRole('button', { name: en.store.install.update }));
}

beforeEach(() => {
  mockInstallFromRegistry.mockReset();
  mockRefresh.mockReset();
});

void describe('#1452 — the update button reports a failed activation', () => {
  void it('names the activation error returned by the ingest', async () => {
    mockInstallFromRegistry.mockResolvedValue({
      ok: true,
      plugin_id: PLUGIN,
      version: '0.2.1',
      registry: 'hub',
      activation_error: ACTIVATION_ERROR,
      next: { install: '/api/v1/install/plugins/x' },
    });

    renderUpdatable();
    clickUpdate();

    await waitFor(() => {
      expect(screen.getByText(new RegExp('entityRefBus'))).toBeTruthy();
    });
  });

  void it('keeps the error visible after the refresh drops the update banner', async () => {
    // The failed activation still bumped `installed_version` (ingest's migrate
    // path writes it), so `router.refresh()` repaints the plugin as merely
    // `installed` and the update banner goes away. The reason must not go with
    // it — that would leave the operator with a red pill and no text.
    mockInstallFromRegistry.mockResolvedValue({
      ok: true,
      plugin_id: PLUGIN,
      version: '0.2.1',
      registry: 'hub',
      activation_error: ACTIVATION_ERROR,
      next: { install: '/api/v1/install/plugins/x' },
    });

    const { rerender } = renderUpdatable();
    clickUpdate();
    await waitFor(() => {
      expect(screen.getByText(new RegExp('entityRefBus'))).toBeTruthy();
    });

    rerender(button('installed'));

    expect(screen.queryByRole('button', { name: en.store.install.update })).toBeNull();
    expect(screen.getByText(new RegExp('entityRefBus'))).toBeTruthy();
  });

  void it('shows no error when the updated version comes up', async () => {
    mockInstallFromRegistry.mockResolvedValue({
      ok: true,
      plugin_id: PLUGIN,
      version: '0.2.1',
      registry: 'hub',
      next: { install: '/api/v1/install/plugins/x' },
    });

    renderUpdatable();
    clickUpdate();

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    expect(screen.queryByText(new RegExp('did not start', 'i'))).toBeNull();
  });
});
