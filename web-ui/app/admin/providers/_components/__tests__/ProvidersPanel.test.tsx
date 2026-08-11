import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../messages/en.json';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { ProvidersPanel } from '../ProvidersPanel';
import {
  ApiError,
  type AdminProvider,
  type ProvidersResponse,
} from '../../../../_lib/api';

/** Any non-empty value; the panel only cares that the field is not blank. */
const NEW_KEY = 'pasted-value';

/** The provider-internal correlation handle OM-26 must never let through. */
const LEAKED_ID = 'req_011CdcPnpMTB8iyAmMBnbem8';

const {
  mockGetProviders,
  mockAssignProvider,
  mockPatchSettings,
  mockVerifyProvider,
} = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockAssignProvider: vi.fn(),
  mockPatchSettings: vi.fn(),
  mockVerifyProvider: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getProviders: mockGetProviders,
  assignProvider: mockAssignProvider,
  patchSettings: mockPatchSettings,
  verifyProvider: mockVerifyProvider,
  // Mirrors the real ApiError, including the OM-09 `code` parse — the panel
  // reads `err.code`, so a mock without it would test nothing.
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

function provider(over: Partial<AdminProvider> = {}): AdminProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    status: 'no_key',
    connected: false,
    models: [],
    ...over,
  };
}

function providersResponse(over: Partial<ProvidersResponse> = {}): ProvidersResponse {
  return {
    providers: [provider()],
    assignments: [],
    vault_available: true,
    ...over,
  };
}

describe('<ProvidersPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockVerifyProvider.mockResolvedValue({ status: 'verified' });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows "Add key" (not "Change key"/"Remove key") for a provider with no key', async () => {
    mockGetProviders.mockResolvedValue(providersResponse());
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(/Add key/)).toBeTruthy();
    expect(screen.queryByText('Change key')).toBeNull();
    expect(screen.queryByText('Remove key')).toBeNull();
  });

  it('shows "Change key" and "Remove key" (not "Add key") for a connected provider — regression guard for #402', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(/Change key/)).toBeTruthy();
    expect(screen.getByText('Remove key')).toBeTruthy();
    expect(screen.queryByText(/Add key/)).toBeNull();
  });

  it('opens the key input and PATCHes the new key when "Change key" is clicked', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockResolvedValue({ updated: [], errors: [] });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: 'sk-ant-new-value' } });
    fireEvent.click(screen.getByText('Save key'));

    await waitFor(() =>
      expect(mockPatchSettings).toHaveBeenCalledWith([
        { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-new-value' },
      ]),
    );
  });

  it('confirms and PATCHes a clearing value when "Remove key" is clicked', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockResolvedValue({ updated: [], errors: [] });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(mockPatchSettings).toHaveBeenCalledWith([
        { key: 'ANTHROPIC_API_KEY', value: null },
      ]),
    );
  });

  it('surfaces an error when removing the key fails (no silent destructive failure)', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockResolvedValue({
      updated: [],
      errors: [{ key: 'ANTHROPIC_API_KEY', message: 'vault offline' }],
    });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(await screen.findByText('vault offline')).toBeTruthy();
  });

  // ── credential-verification chip (OM-02/03/04) ───────────────────────────
  // The old chip had two states and showed "CONNECTED" for any non-empty vault
  // string, which is exactly how a dead key looked healthy for 76 minutes.

  it('shows "no key" for a provider with nothing stored', async () => {
    mockGetProviders.mockResolvedValue(providersResponse());
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText('no key')).toBeTruthy();
    expect(screen.queryByText('verified')).toBeNull();
  });

  it('shows "key stored, not verified" — never "connected" — for an unprobed key', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText('key stored, not verified')).toBeTruthy();
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.queryByText('connected')).toBeNull();
  });

  it('shows "verified" plus the verification time for a probed key', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            connected: true,
            status: 'verified',
            verifiedAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText('verified')).toBeTruthy();
    expect(screen.getByText(/^verified .+/)).toBeTruthy();
  });

  it('shows "key rejected" and the provider\'s reason for a rejected key', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            connected: true,
            status: 'invalid',
            verifyError: 'The provider rejected this API key (HTTP 401).',
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText('key rejected')).toBeTruthy();
    expect(
      screen.getByText('The provider rejected this API key (HTTP 401).'),
    ).toBeTruthy();
  });

  it('offers "Test key" once a key exists, and probes on click', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Test key'));

    await waitFor(() => expect(mockVerifyProvider).toHaveBeenCalledWith('anthropic'));
    // …and the row is re-read so the new verdict is what the operator sees.
    await waitFor(() => expect(mockGetProviders).toHaveBeenCalledTimes(2));
  });

  it('does not offer "Test key" when there is no key to test', async () => {
    mockGetProviders.mockResolvedValue(providersResponse());
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    await screen.findByText('no key');
    expect(screen.queryByText('Test key')).toBeNull();
  });

  it('auto-verifies a freshly saved key so a typo surfaces here, not in chat', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockResolvedValue({ updated: [], errors: [] });
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: 'sk-ant-new-value' } });
    fireEvent.click(screen.getByText('Save key'));

    await waitFor(() => expect(mockVerifyProvider).toHaveBeenCalledWith('anthropic'));
  });

  it('does not PATCH when the remove confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText('Remove key'));

    expect(confirm).toHaveBeenCalled();
    expect(mockPatchSettings).not.toHaveBeenCalled();
  });
  // OM-11 — "Anmelden →" was offered unconditionally, because the provider DTO
  // carried only `connected`/`status` and no way to know whether the CLI is
  // even on this server. Clicking it landed the operator on a tab that said
  // "NICHT GEFUNDEN" with no action available. An offer you cannot accept is
  // worse than no offer.
  it('OM-11: a CLI provider whose binary is missing offers a DISABLED login with a reason', async () => {
    const onSwitch = vi.fn();
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            id: 'claude-cli',
            label: 'Claude CLI',
            toolLess: true,
            connected: false,
            status: 'no_key',
            installed: false,
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={onSwitch} />);

    const button = (await screen.findByRole('button', {
      name: /Log in/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // The reason must be visible, not only in a tooltip.
    expect(
      screen.getByText(/Claude CLI is not installed on this server/i),
    ).toBeTruthy();

    fireEvent.click(button);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('OM-11: an INSTALLED CLI provider still offers a working login', async () => {
    const onSwitch = vi.fn();
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            id: 'claude-cli',
            label: 'Claude CLI',
            toolLess: true,
            connected: false,
            status: 'no_key',
            installed: true,
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={onSwitch} />);

    const button = (await screen.findByRole('button', {
      name: /Log in/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSwitch).toHaveBeenCalled();
  });

  // Backward compatibility: a pre-OM-11 middleware sends no `installed` at all.
  // Treating that as "missing" would disable a working action on every older
  // server, so `undefined` must keep the previous behaviour.
  // ── OM-09: errors explain themselves, in the operator's language ─────────
  // The reported state: a rejected key rendered the middleware's English
  // sentence verbatim in a German UI, next to a bare "/help" link.

  it('OM-09: a rejected key renders the localized catalogue copy, not the English sentence', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            connected: true,
            status: 'invalid',
            verifyError:
              "The provider rejected this API key (HTTP 401). Check the value in the provider's console and paste it again.",
            verifyErrorCode: 'providers.key_rejected',
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(
      await screen.findByText(en.errorHelp.providers.key_rejected.what),
    ).toBeTruthy();
    expect(screen.getByText(en.errorHelp.providers.key_rejected.next)).toBeTruthy();
    expect(screen.queryByText(/The provider rejected this API key/)).toBeNull();
  });

  // Backward compatibility, and its own case on purpose: a pre-#604 middleware
  // sends `verifyError` and no code at all. An English sentence beats nothing.
  it('OM-09: a payload with verifyError and NO code still renders verifyError', async () => {
    const SENTENCE = 'The provider rejected this API key (HTTP 401).';
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({ connected: true, status: 'invalid', verifyError: SENTENCE }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(SENTENCE)).toBeTruthy();
  });

  it('OM-09: a failed key save shows catalogue copy, never the server message', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockRejectedValue(
      new ApiError(
        503,
        'PATCH /v1/admin/settings failed: 503',
        '{"code":"settings.vault_unavailable","message":"vault sealed"}',
      ),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: NEW_KEY } });
    fireEvent.click(screen.getByText('Save key'));

    const headline = await screen.findByText(
      en.errorHelp.settings.vault_unavailable.what,
    );
    // `friendlyError` used to make this exact string the whole paragraph.
    expect(screen.queryByText('vault sealed')).toBeNull();
    expect(headline.textContent).not.toContain('settings.vault_unavailable');
  });

  // The FIRST request the panel makes, and the one it had no catalogue path
  // for: a failed load rendered `GET /v1/admin/providers failed: 500` as the
  // whole message — assembled client-side, English in every locale.
  it('OM-09: a failed LOAD renders the catalogue copy, not the request line', async () => {
    mockGetProviders.mockRejectedValue(
      new ApiError(
        500,
        'GET /v1/admin/providers failed: 500',
        '{"code":"providers.read_failed","message":"database unavailable"}',
      ),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(
      await screen.findByText(en.errorHelp.providers.read_failed.what),
    ).toBeTruthy();
    expect(screen.getByText(en.errorHelp.providers.read_failed.next)).toBeTruthy();
    expect(screen.queryByText(/GET \/v1\/admin\/providers failed/)).toBeNull();
    // The server's own English sentence survives only inside the disclosure.
    expect(screen.queryByText('database unavailable')).toBeNull();
  });

  it('OM-09: a failed LOAD with no code falls back to the localized load line', async () => {
    mockGetProviders.mockRejectedValue(
      new ApiError(502, 'GET /v1/admin/providers failed: 502', 'Bad Gateway'),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    expect(await screen.findByText(en.adminProviders.loadError)).toBeTruthy();
    expect(screen.queryByText(/GET \/v1\/admin\/providers failed/)).toBeNull();
  });

  // #604 fixup: `settings.no_valid_changes` used to answer a rejected VALUE
  // too, and its copy told the operator to reload — a false diagnosis and an
  // action that cannot work. The route now separates the two codes.
  it('OM-09: a key the server refuses says to correct the value, not to reload', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockRejectedValue(
      new ApiError(
        400,
        'PATCH /v1/admin/settings failed: 400',
        '{"code":"settings.invalid_values","errors":[{"key":"ANTHROPIC_API_KEY",' +
          '"message":"Anthropic-Keys beginnen mit \\"sk-ant-\\""}]}',
      ),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: 'not-an-anthropic-key' } });
    fireEvent.click(screen.getByText('Save key'));

    expect(
      await screen.findByText(en.errorHelp.settings.invalid_values.what),
    ).toBeTruthy();
    expect(
      screen.getByText(en.errorHelp.settings.invalid_values.next),
    ).toBeTruthy();
    expect(
      screen.queryByText(en.errorHelp.settings.no_valid_changes.next),
    ).toBeNull();
  });

  it('OM-09: the raw body is disclosed only through supportDetail, redacted', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [provider({ connected: true, status: 'unverified' })],
      }),
    );
    mockPatchSettings.mockRejectedValue(
      new ApiError(
        500,
        'PATCH /v1/admin/settings failed: 500',
        '{"code":"settings.write_failed","message":"upstream said no",' +
          `"request_id":"${LEAKED_ID}"}`,
      ),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Change key/));
    const input = await screen.findByPlaceholderText('Paste API key …');
    fireEvent.change(input, { target: { value: NEW_KEY } });
    fireEvent.click(screen.getByText('Save key'));

    await screen.findByText(en.errorHelp.settings.write_failed.what);
    const body = document.body.textContent ?? '';
    expect(body).toContain('[redacted]');
    expect(body).not.toContain(LEAKED_ID);
  });

  it('OM-11: `installed` absent from the DTO keeps the login enabled', async () => {
    const onSwitch = vi.fn();
    mockGetProviders.mockResolvedValue(
      providersResponse({
        providers: [
          provider({
            id: 'claude-cli',
            label: 'Claude CLI',
            toolLess: true,
            connected: false,
            status: 'no_key',
          }),
        ],
      }),
    );
    renderWithIntl(<ProvidersPanel onSwitchToSubscriptions={onSwitch} />);

    const button = (await screen.findByRole('button', {
      name: /Log in/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
