import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { CredentialsEditor } from '../CredentialsEditor';
import type { PluginSetupField } from '../../../_lib/storeTypes';

/**
 * OM-17 — the finding with the highest value in the whole report.
 *
 * A tester installed the Google Workspace plugin, saw an email field with a
 * masked field directly beneath it, and entered their work email and their real
 * Google account password. Both were accepted silently and confirmed as
 * "gespeichert". They wrote: "Ich arbeite seit Monaten täglich mit
 * KI-Werkzeugen und Systemkonfiguration. Wenn ich an dieser Stelle ein Login
 * sehe, dann ist das kein Anwenderfehler."
 *
 * omadia never asks for a Google password. The masking was purely type-driven
 * and there was nothing anywhere telling the operator what the field wanted.
 */

const { mockListKeys, mockPatchSecrets } = vi.hoisted(() => ({
  mockListKeys: vi.fn(),
  mockPatchSecrets: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  listInstalledSecretKeys: mockListKeys,
  patchInstalledSecrets: mockPatchSecrets,
  patchInstalledConfig: vi.fn(),
  fetchSetupFieldOptions: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
    }
  },
}));

const SA_EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$';

function field(over: Partial<PluginSetupField> = {}): PluginSetupField {
  return {
    key: 'gw_sa_private_key',
    label: 'Service account private key',
    type: 'secret',
    ...over,
  };
}

describe('<CredentialsEditor /> — OM-17 password misuse guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListKeys.mockResolvedValue({
      keys: [],
      config_keys: [],
      config_values: {},
    });
    mockPatchSecrets.mockResolvedValue({
      keys: [],
      config_keys: [],
      config_values: {},
    });
  });

  it('renders the "no account password" warning under a secret field', async () => {
    renderWithIntl(
      <CredentialsEditor pluginId="gw" setupFields={[field()]} />,
      { locale: 'de' },
    );

    expect(
      await screen.findByText(/Hier gehört kein Konto-Passwort hinein/),
    ).toBeTruthy();
  });

  it('does NOT render the warning on a plain config field', async () => {
    renderWithIntl(
      <CredentialsEditor
        pluginId="gw"
        setupFields={[field({ key: 'base_url', type: 'url' })]}
      />,
      { locale: 'de' },
    );

    await screen.findByDisplayValue('');
    expect(screen.queryByText(/Konto-Passwort/)).toBeNull();
  });

  it('blocks save while a value violates the declared pattern', async () => {
    renderWithIntl(
      <CredentialsEditor
        pluginId="gw"
        setupFields={[
          field({
            key: 'gw_sa_client_email',
            type: 'string',
            pattern: SA_EMAIL_PATTERN,
            pattern_hint: { de: 'erwartet …@….iam.gserviceaccount.com' },
          }),
        ]}
      />,
      { locale: 'de' },
    );

    const input = await screen.findByRole('textbox');
    // Exactly what the tester typed: their own work address.
    fireEvent.change(input, { target: { value: 'tester@customer-company.de' } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'iam.gserviceaccount.com',
      );
    });

    const save = screen.getByRole('button', { name: /Speichern/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(save);
    expect(mockPatchSecrets).not.toHaveBeenCalled();
  });

  it('allows save once the value matches the pattern', async () => {
    renderWithIntl(
      <CredentialsEditor
        pluginId="gw"
        setupFields={[
          field({
            key: 'gw_sa_client_email',
            type: 'string',
            pattern: SA_EMAIL_PATTERN,
          }),
        ]}
      />,
      { locale: 'de' },
    );

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, {
      target: { value: 'omadia@my-project.iam.gserviceaccount.com' },
    });

    const save = screen.getByRole('button', { name: /Speichern/i });
    await waitFor(() => {
      expect((save as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mockPatchSecrets).toHaveBeenCalled();
    });
  });

  it('shows the manifest placeholder when nothing is stored', async () => {
    // The manifest already declared `placeholder`; both renderers threw it away
    // and showed state-derived text (or a row of bullets) instead — hiding the
    // one hint that distinguishes a key from a password.
    renderWithIntl(
      <CredentialsEditor
        pluginId="gw"
        setupFields={[
          field({
            key: 'gw_sa_client_email',
            type: 'string',
            placeholder: 'omadia@my-project.iam.gserviceaccount.com',
          }),
        ]}
      />,
      { locale: 'de' },
    );

    const input = await screen.findByRole('textbox');
    expect((input as HTMLInputElement).placeholder).toBe(
      'omadia@my-project.iam.gserviceaccount.com',
    );
  });
});
