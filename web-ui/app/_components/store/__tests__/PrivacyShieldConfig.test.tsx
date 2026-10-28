import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';
import { PrivacyModePicker } from '../PrivacyModePicker';
import { PrivacyShieldBanner } from '../../PrivacyShieldBanner';

/**
 * The Privacy Shield settings an admin could not see or reach in the store:
 *
 *  - #1510 — "Per-tool (whitelist)" pointed at `_privacy_bypass_scopes`, a
 *    field no page showed. The list is now edited next to the mode.
 *  - #1508 — with `OMADIA_PRIVACY_FORCE_GUARDED` on, "Bypass" stayed
 *    selectable and claimed raw results reach the LLM. The picker now shows
 *    the org lock.
 *  - #1507 — uninstalling the Privacy Guard silently turned masking off. The
 *    confirm dialog says so, and the dashboard/admin banner shows the state.
 */

const { mockGetInstalled, mockGetPosture, mockUpdateConfig } = vi.hoisted(() => ({
  mockGetInstalled: vi.fn(),
  mockGetPosture: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: vi.fn(),
  configureInstallJob: vi.fn(),
  getPluginGrants: vi.fn().mockResolvedValue(null),
  deleteUploadedPackage: vi.fn(),
  getInstalledPlugin: mockGetInstalled,
  getPrivacyPosture: mockGetPosture,
  installFromRegistry: vi.fn(),
  uninstallPlugin: vi.fn(),
  updateInstalledPluginConfig: mockUpdateConfig,
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

const PLUGIN = '@omadia/agent-confluence';
const t = en.store.install;

function installed(config: Record<string, unknown>): unknown {
  return {
    id: PLUGIN,
    installed_version: '1.0.0',
    installed_at: '2026-10-28T08:00:00.000Z',
    status: 'active',
    config,
    activation_failure_count: 0,
    last_activation_error: null,
    last_activation_error_at: null,
  };
}

function posture(forceGuarded: boolean): unknown {
  return {
    shield_active: true,
    force_guarded: forceGuarded,
    provider_ids: ['@omadia/plugin-privacy-guard'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPosture.mockResolvedValue(posture(false));
});

describe('PrivacyModePicker — per-tool list (#1510)', () => {
  it('shows the stored list and saves an edited one', async () => {
    mockGetInstalled.mockResolvedValue(
      installed({ _privacy_mode: 'per_tool', _privacy_bypass_scopes: ['confluence_search'] }),
    );
    mockUpdateConfig.mockResolvedValue({
      updated: {
        id: PLUGIN,
        status: 'active',
        config: {
          _privacy_mode: 'per_tool',
          _privacy_bypass_scopes: ['confluence_search', 'confluence_get_page'],
        },
      },
    });
    renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);

    const input = await screen.findByLabelText(t.privacyScopesLabel);
    expect((input as HTMLInputElement).value).toBe('confluence_search');
    expect(screen.queryByText(/_privacy_bypass_scopes/)).toBeNull();

    fireEvent.change(input, {
      target: { value: 'confluence_search, confluence_get_page' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.privacyScopesSave }));

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, {
        _privacy_bypass_scopes: 'confluence_search, confluence_get_page',
      }),
    );
  });

  it('warns while the list is empty', async () => {
    mockGetInstalled.mockResolvedValue(installed({ _privacy_mode: 'per_tool' }));
    renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);
    expect(await screen.findByText(t.privacyScopesEmpty)).toBeTruthy();
  });

  it('shows no list editor outside per-tool mode', async () => {
    mockGetInstalled.mockResolvedValue(installed({ _privacy_mode: 'bypass' }));
    renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);
    await screen.findByText(t.privacyBypassHelp);
    expect(screen.queryByLabelText(t.privacyScopesLabel)).toBeNull();
  });
});

describe('PrivacyModePicker — org lock (#1508)', () => {
  it('locks the picker and drops the "raw results reach the LLM" claim', async () => {
    mockGetInstalled.mockResolvedValue(installed({ _privacy_mode: 'bypass' }));
    mockGetPosture.mockResolvedValue(posture(true));
    renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);

    expect(await screen.findByTestId('privacy-org-lock')).toBeTruthy();
    const select = screen.getByLabelText(t.privacyModeLabel) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('guarded');
    expect(screen.getByText(t.privacyLockedHelp)).toBeTruthy();
    expect(screen.queryByText(t.privacyBypassHelp)).toBeNull();
    // The stored bypass is named as ineffective, not hidden.
    expect(screen.getByText(/has no effect while the org policy is active/)).toBeTruthy();
  });

  it('stays editable when the posture cannot be read', async () => {
    mockGetInstalled.mockResolvedValue(installed({ _privacy_mode: 'bypass' }));
    mockGetPosture.mockRejectedValue(new Error('down'));
    renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);
    await screen.findByText(t.privacyBypassHelp);
    const select = screen.getByLabelText(t.privacyModeLabel) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
  });
});

describe('uninstall dialog — Privacy Guard (#1507)', () => {
  async function openDialog(provides: string[]): Promise<void> {
    mockGetInstalled.mockResolvedValue(installed({}));
    renderWithIntl(
      <InstallButton
        pluginId="@omadia/plugin-privacy-guard"
        pluginName="Privacy Guard"
        installState="installed"
        enabled
        provides={provides}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Uninstall Privacy Guard' }),
    );
  }

  it('says that data protection stops', async () => {
    await openDialog(['privacy.redact@1']);
    expect(screen.getByTestId('uninstall-privacy-warning').textContent).toContain(
      t.confirmRemovePrivacyShield,
    );
  });

  it('hides the uninstall button for the last shield under the org policy', async () => {
    mockGetInstalled.mockResolvedValue(installed({}));
    mockGetPosture.mockResolvedValue({
      shield_active: true,
      force_guarded: true,
      provider_ids: ['@omadia/plugin-privacy-guard'],
    });
    renderWithIntl(
      <InstallButton
        pluginId="@omadia/plugin-privacy-guard"
        pluginName="Privacy Guard"
        installState="installed"
        enabled
        provides={['privacy.redact@1']}
      />,
    );
    expect((await screen.findByTestId('uninstall-locked')).textContent).toContain(
      t.uninstallBlockedByPolicy,
    );
    expect(screen.queryByRole('button', { name: 'Uninstall Privacy Guard' })).toBeNull();
  });

  it('adds nothing for an ordinary plugin', async () => {
    await openDialog([]);
    expect(screen.queryByTestId('uninstall-privacy-warning')).toBeNull();
  });
});

describe('PrivacyShieldBanner (#1507)', () => {
  it('names the off state, and the useless org clamp when it is set', () => {
    const { unmount } = renderWithIntl(
      <PrivacyShieldBanner
        posture={{ shield_active: false, force_guarded: false, provider_ids: [] }}
      />,
    );
    expect(screen.getByText(en.privacyShieldBanner.title)).toBeTruthy();
    expect(screen.getByText(en.privacyShieldBanner.body)).toBeTruthy();
    unmount();

    renderWithIntl(
      <PrivacyShieldBanner
        posture={{ shield_active: false, force_guarded: true, provider_ids: [] }}
      />,
    );
    expect(screen.getByText(en.privacyShieldBanner.bodyForceGuarded)).toBeTruthy();
  });

  it('says "installed but not running" when a provider is installed', () => {
    renderWithIntl(
      <PrivacyShieldBanner
        posture={{
          shield_active: false,
          force_guarded: false,
          provider_ids: ['@omadia/plugin-privacy-guard'],
        }}
      />,
    );
    expect(screen.getByText(en.privacyShieldBanner.bodyNotRunning)).toBeTruthy();
  });

  it('renders nothing while the shield runs or the posture is unknown', () => {
    const { container } = renderWithIntl(
      <>
        <PrivacyShieldBanner posture={null} />
        <PrivacyShieldBanner
          posture={{ shield_active: true, force_guarded: false, provider_ids: [] }}
        />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});
