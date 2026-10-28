import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import de from '../../../../messages/de.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';
import type { PluginReadiness } from '../../../_lib/storeTypes';

/**
 * #1456 — the plugin page, after the install drawer is closed.
 *
 * This is the surface the issue reproduces on: reload the page and the red
 * pill says "Aktivierung fehlgeschlagen" while the reason was the plugin API's
 * English exception sentence (and before #1452, only a hover tooltip). It must
 * now read as German operator copy, with the sentence demoted to a technical
 * detail.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { mockInstallFromRegistry } = vi.hoisted(() => ({
  mockInstallFromRegistry: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: vi.fn(),
  configureInstallJob: vi.fn(),
  getPluginGrants: vi.fn().mockResolvedValue(null),
  deleteUploadedPackage: vi.fn(),
  getInstalledPlugin: vi.fn(),
  installFromRegistry: mockInstallFromRegistry,
  uninstallPlugin: vi.fn(),
  updateInstalledPluginConfig: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const PLUGIN = '@omadia/integration-odoo';
const RAW =
  "plugin '@omadia/integration-odoo' called ctx.services.get('entityRefBus') but its manifest does not declare that capability";

function renderInstalled(readiness: PluginReadiness): void {
  renderWithIntl(
    <InstallButton
      pluginId={PLUGIN}
      pluginName="Odoo Connector"
      installState="installed"
      enabled
      blockingReasons={[]}
      readiness={readiness}
    />,
    { locale: 'de' },
  );
}

void describe('the installed plugin page explains a failed activation', () => {
  void it('reads as German operator copy, with the raw sentence behind it', () => {
    renderInstalled({
      state: 'errored',
      missing_fields: [],
      verified_at: null,
      error_detail: RAW,
      error_reason: { code: 'capability_not_declared', capability: 'entityRefBus' },
    });

    const copy = de.store.activationError.capability_not_declared;
    expect(screen.getByText(copy.what)).toBeTruthy();
    expect(screen.getByText(copy.next)).toBeTruthy();
    expect(
      screen.getByText(de.store.activationError.technicalDetail.replace('{raw}', RAW)),
    ).toBeTruthy();
    // The old lie: the English author-facing sentence AS the message. It may
    // only appear inside the technical-detail line asserted above.
    expect(screen.queryByText(RAW)).toBeNull();
  });

  void it('still explains a failure an older build recorded without a code', () => {
    renderInstalled({
      state: 'errored',
      missing_fields: [],
      verified_at: null,
      error_detail: RAW,
    });

    expect(screen.getByText(de.store.activationError.unknown.what)).toBeTruthy();
    expect(
      screen.getByText(de.store.activationError.technicalDetail.replace('{raw}', RAW)),
    ).toBeTruthy();
  });

  void it('explains an update that did not come back up, in German (#1456)', async () => {
    mockInstallFromRegistry.mockResolvedValue({
      ok: true,
      plugin_id: PLUGIN,
      version: '0.3.0',
      registry: 'default',
      activation_error: RAW,
      activation_error_reason: {
        code: 'capability_not_declared',
        capability: 'entityRefBus',
      },
      next: { install: '/api/v1/install/plugins/x' },
    });

    renderWithIntl(
      <InstallButton
        pluginId={PLUGIN}
        pluginName="Odoo Connector"
        installState="update-available"
        enabled
        blockingReasons={[]}
        installedVersion="0.2.0"
        availableVersion="0.3.0"
        readiness={{ state: 'ready', missing_fields: [], verified_at: null }}
      />,
      { locale: 'de' },
    );

    fireEvent.click(screen.getByRole('button', { name: de.store.install.update }));

    const copy = de.store.activationError.capability_not_declared;
    await waitFor(() => {
      expect(screen.getByText(copy.what)).toBeTruthy();
    });
    expect(screen.getByText(copy.next)).toBeTruthy();
    expect(
      screen.getByText(de.store.activationError.technicalDetail.replace('{raw}', RAW)),
    ).toBeTruthy();
    // Never the raw sentence as the message itself.
    expect(screen.queryByText(RAW)).toBeNull();
  });

  void it('says nothing about activation when the plugin is ready', () => {
    renderInstalled({ state: 'ready', missing_fields: [], verified_at: null });
    expect(screen.queryByTestId('activation-failure')).toBeNull();
  });
});
