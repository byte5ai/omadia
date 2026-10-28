import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { PluginReadiness, PluginSetupField } from '../../../_lib/storeTypes';
import { ActivationFailureNotice } from '../ActivationFailureNotice';
import { CredentialsEditor } from '../CredentialsEditor';
import { PostInstallNextSteps } from '../PostInstallNextSteps';
import { StateBadge } from '../StateBadge';

/**
 * Sweep 2 / N03 — the store states a plugin's activation truthfully.
 *
 *  - #1456 an activation failure reads in the operator's language, with the
 *    plugin-API sentence demoted to a technical detail;
 *  - #1496 an errored plugin gets no success styling;
 *  - #1492 the next-step hint fits the plugin's kind and attachments;
 *  - #1497 saving setup fields says whether the plugin came back up.
 */

const { mockListKeys, mockPatchSecrets, mockRefresh } = vi.hoisted(() => ({
  mockListKeys: vi.fn(),
  mockPatchSecrets: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  listInstalledSecretKeys: mockListKeys,
  patchInstalledSecrets: mockPatchSecrets,
  patchInstalledConfig: vi.fn(),
  fetchSetupFieldOptions: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const RAW =
  "plugin '@omadia/integration-odoo' called ctx.services.get('entityRefBus') but its manifest does not declare that capability — add 'entityRefBus@<major>' to the manifest's `requires:` list";

const ERRORED: PluginReadiness = {
  state: 'errored',
  missing_fields: [],
  verified_at: null,
  error_detail: RAW,
  error_code: 'capability_not_declared',
};
const READY: PluginReadiness = {
  state: 'ready',
  missing_fields: [],
  verified_at: '2026-10-28T08:00:00.000Z',
};

describe('ActivationFailureNotice (#1456)', () => {
  it('reads fully German, without the manifest instruction as the headline', () => {
    renderWithIntl(<ActivationFailureNotice code="capability_not_declared" detail={RAW} />, {
      locale: 'de',
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Diese Version des Plugins läuft nicht auf diesem Server.');
    expect(alert.textContent).toContain('Installiere eine andere Version');
    // The raw sentence is still reachable — collapsed, as a technical detail.
    const summary = screen.getByText('Technisches Detail');
    expect(summary.closest('details')?.textContent).toContain('entityRefBus');
    expect(screen.getByText('Diese Version des Plugins läuft nicht auf diesem Server.').textContent).not.toContain('manifest');
  });

  it('degrades a missing or unknown code to the localized fallback', () => {
    renderWithIntl(<ActivationFailureNotice code={undefined} detail="legacy reason" />, {
      locale: 'de',
    });
    expect(screen.getByRole('alert').textContent).toContain('Das Plugin ist nicht gestartet.');
    renderWithIntl(<ActivationFailureNotice code="something_new" detail={null} />);
    expect(screen.getAllByRole('alert')[1]?.textContent).toContain('The plugin did not start.');
  });
});

describe('StateBadge (#1456)', () => {
  it('puts the localized reason, not the raw tail, into title=', () => {
    renderWithIntl(<StateBadge state="installed" readiness={ERRORED} />, { locale: 'de' });
    const pill = screen.getByText('Aktivierung fehlgeschlagen');
    expect(pill.getAttribute('title')).toBe(
      'Diese Version des Plugins läuft nicht auf diesem Server.',
    );
  });
});

describe('PostInstallNextSteps (#1496, #1492)', () => {
  it('renders no success styling or chat link for an errored plugin', () => {
    const { container } = renderWithIntl(
      <PostInstallNextSteps pluginName="Odoo Connector" readiness={ERRORED} kind="integration" />,
    );
    expect(container.textContent).toBe('');
    expect(screen.queryByText('Try it in chat')).toBeNull();
  });

  it('renders nothing for a plugin whose credentials were refused', () => {
    const { container } = renderWithIntl(
      <PostInstallNextSteps
        pluginName="Odoo Connector"
        readiness={{ ...READY, state: 'connection_failed', verified_at: null }}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('does not ask to attach an agent that is attached already', () => {
    renderWithIntl(
      <PostInstallNextSteps
        pluginName="SEO Analyst"
        readiness={READY}
        kind="agent"
        attachedTo={['Default orchestrator']}
      />,
    );
    expect(screen.getByText('"SEO Analyst" is attached to Default orchestrator.')).toBeTruthy();
    expect(screen.queryByText('Attach to an orchestrator')).toBeNull();
    expect(screen.getByText('Manage orchestrators')).toBeTruthy();
  });

  it('still offers attaching an agent that is not attached anywhere', () => {
    renderWithIntl(
      <PostInstallNextSteps pluginName="SEO Analyst" readiness={READY} kind="agent" attachedTo={[]} />,
    );
    expect(screen.getByText('Attach to an orchestrator')).toBeTruthy();
  });

  it('sends neither integrations nor extensions to an orchestrator or the chat', () => {
    renderWithIntl(
      <PostInstallNextSteps pluginName="Odoo Connector" readiness={READY} kind="integration" attachedTo={null} />,
    );
    expect(screen.getByText(/Agents that depend on it use it automatically/)).toBeTruthy();
    renderWithIntl(
      <PostInstallNextSteps pluginName="Dev Platform" readiness={READY} kind="extension" attachedTo={null} />,
    );
    expect(screen.getByText('"Dev Platform" is installed and running.')).toBeTruthy();
    expect(screen.queryByText('Attach to an orchestrator')).toBeNull();
    expect(screen.queryByText('Try it in chat')).toBeNull();
  });

  it('points a plugin that needs setup at the form, without a success check', () => {
    renderWithIntl(
      <PostInstallNextSteps
        pluginName="Odoo Connector"
        readiness={{ state: 'config_required', missing_fields: ['odoo_api_key'], verified_at: null }}
        kind="integration"
      />,
    );
    expect(screen.getByText(/needs setup before it can run/)).toBeTruthy();
    expect(screen.getByText('Complete setup (1 missing)')).toBeTruthy();
  });
});

describe('CredentialsEditor save × activation (#1497)', () => {
  const fields: PluginSetupField[] = [
    { key: 'odoo_api_key', label: { en: 'API key' }, type: 'secret', required: true } as PluginSetupField,
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockListKeys.mockResolvedValue({ keys: ['odoo_api_key'], config_keys: [], config_values: {} });
  });

  async function saveAfterDelete(): Promise<void> {
    renderWithIntl(<CredentialsEditor pluginId="@omadia/integration-odoo" setupFields={fields} />);
    const trash = await screen.findByRole('button', { name: /Delete secret on next save/i });
    fireEvent.click(trash);
    fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }));
  }

  it('says "saved but did not start" with the reason, never "✓ Saved", and refreshes', async () => {
    mockPatchSecrets.mockResolvedValue({
      keys: [],
      config_keys: [],
      config_values: {},
      activation: {
        state: 'errored',
        ok: false,
        error: "plugin '@omadia/integration-odoo' has no secret 'odoo_api_key' in vault",
        error_code: 'secret_missing',
      },
    });
    await saveAfterDelete();
    await waitFor(() => {
      expect(screen.getByText(/Saved — but the plugin did not start/)).toBeTruthy();
    });
    expect(screen.getByText(/A required secret is not stored./)).toBeTruthy();
    expect(screen.queryByText('✓ Saved')).toBeNull();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('keeps "✓ Saved" when the plugin came back up', async () => {
    mockPatchSecrets.mockResolvedValue({
      keys: [],
      config_keys: [],
      config_values: {},
      activation: { state: 'active', ok: true, error: null, error_code: null },
    });
    await saveAfterDelete();
    await waitFor(() => {
      expect(screen.getByText('✓ Saved')).toBeTruthy();
    });
    expect(mockRefresh).toHaveBeenCalled();
  });
});
