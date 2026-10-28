import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { CredentialsEditor } from '../CredentialsEditor';
import type { PluginSetupField } from '../../../_lib/storeTypes';

/**
 * #1475 — saving re-activates the plugin and can take seconds. The busy button
 * used to repeat its idle label ("Save (1)"), and the German `saving` string
 * was the infinitive "Speichern", so nothing on screen said work was underway.
 */

const { mockListKeys, mockPatchSecrets } = vi.hoisted(() => ({
  mockListKeys: vi.fn(),
  mockPatchSecrets: vi.fn(),
}));

// #1497 — the editor refreshes the server-rendered page after a save.
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

const FIELD: PluginSetupField = {
  key: 'odoo_api_key',
  label: { en: 'API key' },
  type: 'secret',
};

describe('<CredentialsEditor /> — #1475 busy label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListKeys.mockResolvedValue({ keys: [], config_keys: [], config_values: {} });
    // Never resolves: the editor stays in its saving state for the assertion.
    mockPatchSecrets.mockReturnValue(new Promise(() => {}));
  });

  it.each([
    ['en', 'not set yet', /^Save \(1\)$/, 'Saving'],
    ['de', 'noch nicht gesetzt', /^Speichern \(1\)$/, 'Wird gespeichert'],
  ] as const)('shows a progress verb while saving (%s)', async (locale, empty, idle, busy) => {
    renderWithIntl(<CredentialsEditor pluginId="odoo" setupFields={[FIELD]} />, {
      locale,
    });

    const input = await screen.findByPlaceholderText(empty);
    fireEvent.change(input, { target: { value: 'new-key' } });
    const save = screen.getByRole('button', { name: idle });
    fireEvent.click(save);

    await waitFor(() => {
      expect(save.textContent).toBe(busy);
    });
    expect(mockPatchSecrets).toHaveBeenCalledTimes(1);
  });
});
