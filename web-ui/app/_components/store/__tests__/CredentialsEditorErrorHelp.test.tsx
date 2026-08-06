import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { CredentialsEditor } from '../CredentialsEditor';
import type { PluginSetupField } from '../../../_lib/storeTypes';

/**
 * OM-09 — the credential editor put the raw identifier on screen.
 *
 * `humanizeError` returned `` `${body.code}: ${body.message}` ``, so a sealed
 * vault read as "runtime.vault_unavailable: vault not wired into runtime
 * route": an internal symbol and an English sentence, in a German UI, telling
 * the operator nothing they could act on.
 *
 * The second case guards the OTHER direction. `runtime.setup_field_invalid`
 * must NOT be swallowed by the catalogue: the manifest's `pattern_hint` names
 * the field and the format it wants, which is strictly more useful than "one
 * value has the wrong format". That is the OM-17 fix, and it stays first.
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
  // Mirrors the real ApiError, including the OM-09 `code` parse.
  ApiError: class ApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        this.code = typeof parsed.code === 'string' ? parsed.code : null;
      } catch {
        this.code = null;
      }
    }
  },
}));

function field(over: Partial<PluginSetupField> = {}): PluginSetupField {
  return {
    key: 'api_token',
    label: 'API token',
    // `string`, not `secret`: a secret renders a password input, which has no
    // ARIA role, and this file is about the error line, not the input.
    type: 'string',
    ...over,
  };
}

async function typeAndSave(value: string): Promise<void> {
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value } });
  const save = await screen.findByRole('button', { name: /Save/i });
  await waitFor(() => {
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(save);
}

describe('<CredentialsEditor /> — OM-09 error help', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListKeys.mockResolvedValue({
      keys: [],
      config_keys: [],
      config_values: {},
    });
  });

  it('resolves a catalogued code to localized copy and keeps the identifier off screen', async () => {
    mockPatchSecrets.mockRejectedValueOnce(
      new ApiError(
        503,
        'PATCH /v1/admin/runtime/installed/gw/secrets failed: 503',
        JSON.stringify({
          code: 'runtime.vault_unavailable',
          message: 'vault not wired into runtime route',
        }),
      ),
    );

    renderWithIntl(
      <CredentialsEditor pluginId="gw" setupFields={[field()]} />,
    );
    await typeAndSave('some-token');

    const headline = await screen.findByText(
      en.errorHelp.runtime.vault_unavailable.what,
    );
    expect(headline.textContent).not.toContain('runtime.vault_unavailable');
    expect(
      screen.getByText(en.errorHelp.runtime.vault_unavailable.next),
    ).toBeTruthy();
    // The server's own English sentence was the fallback headline before; it
    // may now appear only inside the support disclosure, never on its own.
    expect(
      screen.queryByText('vault not wired into runtime route'),
    ).toBeNull();
  });

  it('keeps the manifest hint ahead of the generic catalogue entry', async () => {
    const HINT = 'expects a service account address, not a person';
    mockPatchSecrets.mockRejectedValueOnce(
      new ApiError(
        400,
        'Bad Request',
        JSON.stringify({
          code: 'runtime.setup_field_invalid',
          message: "value for 'api_token' does not match the expected format",
          field: 'api_token',
          hint: HINT,
        }),
      ),
    );

    renderWithIntl(
      <CredentialsEditor
        pluginId="gw"
        setupFields={[field({ pattern_hint: { en: HINT } })]}
      />,
    );
    await typeAndSave('tester@customer-company.de');

    expect(await screen.findByText(new RegExp(HINT))).toBeTruthy();
    // The generic entry would have been strictly less useful here.
    expect(
      screen.queryByText(en.errorHelp.runtime.setup_field_invalid.what),
    ).toBeNull();
  });
});
