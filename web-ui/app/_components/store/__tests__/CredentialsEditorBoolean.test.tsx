import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { CredentialsEditor } from '../CredentialsEditor';
import type { PluginSetupField } from '../../../_lib/storeTypes';

/**
 * A `boolean` setup field edited after install rendered as a free-text box
 * ("noch nicht gesetzt") that only accepted the literal words true/false. It is
 * a Ja/Nein switch now, with the manifest default pre-selected while nothing is
 * stored.
 */

const { mockListKeys, mockPatchSecrets } = vi.hoisted(() => ({
  mockListKeys: vi.fn(),
  mockPatchSecrets: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  listInstalledSecretKeys: mockListKeys,
  patchInstalledSecrets: mockPatchSecrets,
  patchInstalledConfig: vi.fn(),
  fetchSetupFieldOptions: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const TRACE: PluginSetupField = {
  key: 'teams_card_tool_trace',
  label: { en: 'Answer card: Tool-Trace button', de: 'Antwort-Card: Tool-Trace-Button' },
  type: 'boolean',
  default: true,
};

function radio(name: RegExp): HTMLElement {
  return screen.getByRole('radio', { name });
}

describe('<CredentialsEditor /> — boolean setup fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatchSecrets.mockResolvedValue({ keys: [], config_keys: [], config_values: {} });
  });

  it('shows a Ja/Nein switch with the default pre-selected, not a text box', async () => {
    mockListKeys.mockResolvedValue({ keys: [], config_keys: [], config_values: {} });
    renderWithIntl(<CredentialsEditor pluginId="teams" setupFields={[TRACE]} />, {
      locale: 'de',
    });

    const group = await screen.findByRole('radiogroup', {
      name: 'Antwort-Card: Tool-Trace-Button',
    });
    expect(group).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(radio(/^Ja$/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/^Nein$/).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Standard · noch nicht gespeichert')).toBeTruthy();
  });

  it('reflects a stored "false" and saves a flip as the string the server coerces', async () => {
    mockListKeys.mockResolvedValue({
      keys: [],
      config_keys: ['teams_card_tool_trace'],
      config_values: { teams_card_tool_trace: 'false' },
    });
    renderWithIntl(<CredentialsEditor pluginId="teams" setupFields={[TRACE]} />, {
      locale: 'de',
    });

    await waitFor(() => {
      expect(radio(/^Nein$/).getAttribute('aria-checked')).toBe('true');
    });
    expect(screen.queryByText('Standard · noch nicht gespeichert')).toBeNull();

    fireEvent.click(radio(/^Ja$/));
    expect(radio(/^Ja$/).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Speichern \(1\)/ }));

    await waitFor(() => {
      expect(mockPatchSecrets).toHaveBeenCalledWith('teams', {
        set: { teams_card_tool_trace: 'true' },
      });
    });
  });

  it('re-selecting the stored value is not a pending change', async () => {
    mockListKeys.mockResolvedValue({
      keys: [],
      config_keys: ['teams_card_tool_trace'],
      config_values: { teams_card_tool_trace: 'false' },
    });
    renderWithIntl(<CredentialsEditor pluginId="teams" setupFields={[TRACE]} />, {
      locale: 'de',
    });
    await waitFor(() => {
      expect(radio(/^Nein$/).getAttribute('aria-checked')).toBe('true');
    });
    fireEvent.click(radio(/^Ja$/));
    fireEvent.click(radio(/^Nein$/));
    expect(screen.queryByRole('button', { name: /^Speichern \(1\)/ })).toBeNull();
  });
});
