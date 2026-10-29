import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { PrivacyModePicker } from '../PrivacyModePicker';

/**
 * #1548 — picking "Bypass" used to PATCH `_privacy_mode: 'bypass'` straight
 * from the select's onChange. Every change that starts sending raw results to
 * the LLM provider now waits for a confirm; Cancel sends nothing.
 */

const { mockGetInstalled, mockGetPosture, mockUpdateConfig } = vi.hoisted(() => ({
  mockGetInstalled: vi.fn(),
  mockGetPosture: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  getInstalledPlugin: mockGetInstalled,
  getPrivacyPosture: mockGetPosture,
  updateInstalledPluginConfig: mockUpdateConfig,
  ApiError: class ApiError extends Error {},
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

async function renderPicker(config: Record<string, unknown>): Promise<HTMLSelectElement> {
  mockGetInstalled.mockResolvedValue(installed(config));
  renderWithIntl(<PrivacyModePicker pluginId={PLUGIN} />);
  return (await screen.findByLabelText(t.privacyModeLabel)) as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPosture.mockResolvedValue({
    shield_active: true,
    force_guarded: false,
    provider_ids: ['@omadia/plugin-privacy-guard'],
  });
  mockUpdateConfig.mockResolvedValue({ updated: null });
});

describe('PrivacyModePicker — bypass confirm (#1548)', () => {
  it('asks before storing bypass and sends no PATCH yet', async () => {
    const select = await renderPicker({ _privacy_mode: 'guarded' });
    fireEvent.change(select, { target: { value: 'bypass' } });

    const dialog = screen.getByTestId('privacy-bypass-confirm');
    expect(dialog.textContent).toContain(t.privacyConfirmBypass);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('stores bypass after the confirm', async () => {
    const select = await renderPicker({ _privacy_mode: 'guarded' });
    fireEvent.change(select, { target: { value: 'bypass' } });
    fireEvent.click(screen.getByRole('button', { name: t.privacyConfirmYes }));

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, { _privacy_mode: 'bypass' }),
    );
    await screen.findByText(t.privacyBypassHelp);
    expect(screen.queryByTestId('privacy-bypass-confirm')).toBeNull();
  });

  it('keeps the previous mode on cancel', async () => {
    const select = await renderPicker({ _privacy_mode: 'guarded' });
    fireEvent.change(select, { target: { value: 'bypass' } });
    expect(select.value).toBe('bypass');
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));

    expect(screen.queryByTestId('privacy-bypass-confirm')).toBeNull();
    expect(select.value).toBe('guarded');
    expect(select.disabled).toBe(false);
    expect(screen.getByText(t.privacyGuardedHelp)).toBeTruthy();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('switches back to guarded without a confirm', async () => {
    const select = await renderPicker({ _privacy_mode: 'bypass' });
    fireEvent.change(select, { target: { value: 'guarded' } });

    expect(screen.queryByTestId('privacy-bypass-confirm')).toBeNull();
    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, { _privacy_mode: 'guarded' }),
    );
  });

  it('asks before per-tool turns on a stored tool list', async () => {
    const select = await renderPicker({
      _privacy_mode: 'guarded',
      _privacy_bypass_scopes: ['confluence_search'],
    });
    fireEvent.change(select, { target: { value: 'per_tool' } });

    expect(screen.getByTestId('privacy-bypass-confirm').textContent).toContain(
      'confluence_search',
    );
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t.privacyConfirmYes }));
    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, { _privacy_mode: 'per_tool' }),
    );
  });

  it('switches to per-tool with an empty list without a confirm', async () => {
    const select = await renderPicker({ _privacy_mode: 'guarded' });
    fireEvent.change(select, { target: { value: 'per_tool' } });

    expect(screen.queryByTestId('privacy-bypass-confirm')).toBeNull();
    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, { _privacy_mode: 'per_tool' }),
    );
  });

  it('saves a shortened tool list without a confirm', async () => {
    await renderPicker({
      _privacy_mode: 'per_tool',
      _privacy_bypass_scopes: ['confluence_search', 'confluence_get_page'],
    });
    const input = screen.getByLabelText(t.privacyScopesLabel);
    fireEvent.change(input, { target: { value: 'confluence_search' } });
    fireEvent.click(screen.getByRole('button', { name: t.privacyScopesSave }));

    expect(screen.queryByTestId('privacy-bypass-confirm')).toBeNull();
    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith(PLUGIN, {
        _privacy_bypass_scopes: 'confluence_search',
      }),
    );
  });

  it('cancelling a list edit that adds a tool sends nothing', async () => {
    await renderPicker({ _privacy_mode: 'per_tool', _privacy_bypass_scopes: [] });
    const input = screen.getByLabelText(t.privacyScopesLabel);
    fireEvent.change(input, { target: { value: 'confluence_search' } });
    fireEvent.click(screen.getByRole('button', { name: t.privacyScopesSave }));
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
