import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { CredentialsEditor } from '../CredentialsEditor';
import type { PluginSetupField } from '../../../_lib/storeTypes';

/**
 * #1525 — Privacy Guard's `custom_patterns` takes one regex per line (';' is
 * regex syntax, so newlines are the only separator). The edit form rendered
 * every text field as a single-line input: Enter did nothing, and only one
 * pattern could ever be saved. A `multiline` field is a textarea now.
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

const PATTERNS: PluginSetupField = {
  key: 'custom_patterns',
  label: { en: 'Custom deny-list patterns (advanced)' },
  type: 'string',
  multiline: true,
};

describe('<CredentialsEditor /> — #1525 multi-line setup fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListKeys.mockResolvedValue({
      keys: [],
      config_keys: ['custom_patterns'],
      config_values: { custom_patterns: 'PRJ-\\d{4}' },
    });
    mockPatchSecrets.mockResolvedValue({ keys: [], config_keys: [], config_values: {} });
  });

  it('renders a multiline field as a textarea and saves every line', async () => {
    renderWithIntl(<CredentialsEditor pluginId="pg" setupFields={[PATTERNS]} />, {
      locale: 'de',
    });

    const box = await screen.findByDisplayValue('PRJ-\\d{4}');
    expect(box.tagName).toBe('TEXTAREA');

    fireEvent.change(box, { target: { value: 'PRJ-\\d{4}\nKD[0-9]{3};?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speichern \(1\)/ }));

    await waitFor(() => {
      expect(mockPatchSecrets).toHaveBeenCalled();
    });
    expect(JSON.stringify(mockPatchSecrets.mock.calls)).toContain(
      JSON.stringify('PRJ-\\d{4}\nKD[0-9]{3};?'),
    );
  });

  it('keeps a field without the flag single-line', async () => {
    renderWithIntl(
      <CredentialsEditor
        pluginId="pg"
        setupFields={[{ ...PATTERNS, key: 'custom_terms', multiline: undefined }]}
      />,
      { locale: 'de' },
    );

    const input = await screen.findByRole('textbox');
    expect(input.tagName).toBe('INPUT');
  });
});
