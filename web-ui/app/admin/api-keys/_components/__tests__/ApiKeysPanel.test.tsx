import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiKeysPanel } from '../ApiKeysPanel';
import type { ApiKeyPublicView } from '../../../../_lib/api';

const { mockListApiKeys, mockCreateApiKey, mockRevokeApiKey } = vi.hoisted(() => ({
  mockListApiKeys: vi.fn(),
  mockCreateApiKey: vi.fn(),
  mockRevokeApiKey: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  listApiKeys: mockListApiKeys,
  createApiKey: mockCreateApiKey,
  revokeApiKey: mockRevokeApiKey,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body?: string,
    ) {
      super(message);
    }
  },
}));

function key(over: Partial<ApiKeyPublicView> = {}): ApiKeyPublicView {
  return {
    id: 'key-1',
    label: 'CI bot',
    rateLimitPerMinute: 60,
    scopes: ['chat:write'],
    createdAt: Date.parse('2026-07-01T00:00:00Z'),
    ...over,
  };
}

describe('<ApiKeysPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    // Sane defaults so tests that only assert *whether* the API was called
    // (not its resolved shape) don't hit a destructuring TypeError on an
    // unmocked resolved value.
    mockRevokeApiKey.mockResolvedValue({ key: key() });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when there are no keys', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    expect(await screen.findByText(/No API keys yet/i)).toBeTruthy();
  });

  it('renders an existing key with its label, scope chip, and Active status', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key()] });
    renderWithIntl(<ApiKeysPanel />);

    expect(await screen.findByText('CI bot')).toBeTruthy();
    // The scope also appears as the (checked) create-form checkbox label, so
    // there are two "chat:write" nodes on the page — the chip is one of them.
    expect(screen.getAllByText('chat:write').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('falls back to "Unlabeled" when a key has no label', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key({ label: undefined })] });
    renderWithIntl(<ApiKeysPanel />);

    expect(await screen.findByText('Unlabeled')).toBeTruthy();
  });

  it('shows a revoked key with Revoked status and no revoke button', async () => {
    mockListApiKeys.mockResolvedValue({
      keys: [key({ revokedAt: Date.parse('2026-07-02T00:00:00Z') })],
    });
    renderWithIntl(<ApiKeysPanel />);

    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect(screen.queryByText('Revoke')).toBeNull();
  });

  // #567 core: the operator must be able to copy a key's id (a public MCP
  // binding is keyed on ApiKeyRecord.id). The id is shown verbatim and a
  // click copies it to the clipboard.
  it('shows each key id and copies it to the clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockListApiKeys.mockResolvedValue({ keys: [key({ id: 'key-abc-123' })] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    // The id is rendered verbatim so it can also be selected by hand.
    expect(screen.getByText('key-abc-123')).toBeTruthy();

    const row = screen.getByText('CI bot').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByText(/^Copy ID$/i));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('key-abc-123'));
    expect(await within(row).findByText(/^Copied$/i)).toBeTruthy();
  });

  it('creates a key with the checked default scope and never sends an empty scopes array', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockCreateApiKey.mockResolvedValue({
      key: key(),
      token: 'sk-live-plaintext-token-value',
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(screen.getByText('Create key'));

    await waitFor(() => expect(mockCreateApiKey).toHaveBeenCalledTimes(1));
    const call = mockCreateApiKey.mock.calls[0];
    expect(call).toBeDefined();
    const payload = call?.[0];
    expect(payload.scopes).toEqual(['chat:write']);
    expect(payload.scopes.length).toBeGreaterThan(0); // regression guard: never []
  });

  it('reveals the plaintext token exactly once after creation, with a dismiss-to-confirm reveal', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockCreateApiKey.mockResolvedValue({
      key: key(),
      token: 'sk-live-plaintext-token-value',
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(screen.getByText('Create key'));

    expect(await screen.findByText('sk-live-plaintext-token-value')).toBeTruthy();
    expect(screen.getByText(/only time this token is shown/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('sk-live-plaintext-token-value')).toBeNull();
  });

  it('blocks submission and explains why when the only scope checkbox is unchecked', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(screen.getByRole('checkbox'));

    expect(screen.getByText('Create key')).toHaveProperty('disabled', true);
    expect(screen.getByText(/at least one scope/i)).toBeTruthy();
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it('requires a confirmation step before revoking — the first click only arms it', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key()] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    fireEvent.click(screen.getByText('Revoke'));

    expect(mockRevokeApiKey).not.toHaveBeenCalled();
    expect(screen.getByText(/can't be undone/i)).toBeTruthy();

    fireEvent.click(screen.getByText('Confirm revoke'));
    await waitFor(() => expect(mockRevokeApiKey).toHaveBeenCalledWith('key-1'));
  });

  it('cancelling the revoke confirmation does not call the API', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key()] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    fireEvent.click(screen.getByText('Revoke'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockRevokeApiKey).not.toHaveBeenCalled();
    expect(screen.getByText('Revoke')).toBeTruthy();
  });

  it('updates the row to Revoked in place after a confirmed revoke', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key()] });
    mockRevokeApiKey.mockResolvedValue({
      key: key({ revokedAt: Date.parse('2026-07-03T00:00:00Z') }),
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    fireEvent.click(screen.getByText('Revoke'));
    fireEvent.click(screen.getByText('Confirm revoke'));

    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect(screen.queryByText('Confirm revoke')).toBeNull();
  });

  it('shows a validation error and disables submit for an out-of-range rate limit', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    const rateLimitInput = screen.getByPlaceholderText('60');
    fireEvent.change(rateLimitInput, { target: { value: '99999' } });

    expect(screen.getByText('Create key')).toHaveProperty('disabled', true);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it('rejects a non-integer rate limit instead of silently truncating it', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.change(screen.getByPlaceholderText('60'), { target: { value: '60.7' } });

    expect(screen.getByText('Create key')).toHaveProperty('disabled', true);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  // Regression guard for a codex review finding: creating a second key while
  // the first one's plaintext token is still displayed would silently
  // overwrite it in React state before the operator could copy it — the
  // create form must stay blocked until the reveal is explicitly dismissed.
  it('blocks creating a second key while a token reveal is still showing', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockCreateApiKey.mockResolvedValue({
      key: key(),
      token: 'sk-live-plaintext-token-value',
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(screen.getByText('Create key'));

    expect(await screen.findByText('sk-live-plaintext-token-value')).toBeTruthy();
    expect(screen.getByText('Create key')).toHaveProperty('disabled', true);
    expect(screen.getByText(/Dismiss the token above/i)).toBeTruthy();
    expect(mockCreateApiKey).toHaveBeenCalledTimes(1);

    // Dismissing re-enables it.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.getByText('Create key')).toHaveProperty('disabled', false);
  });

  // Regression guard for a codex review finding: a single global `pendingId`
  // meant a second row's revoke could clear the first row's busy/confirm
  // state (and vice versa) when either promise settled.
  it('revokes two different keys concurrently without one clobbering the other\'s confirm state', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key({ id: 'key-1' }), key({ id: 'key-2', label: 'Second bot' })] });
    let resolveFirst: ((v: { key: ApiKeyPublicView }) => void) | undefined;
    mockRevokeApiKey.mockImplementation((id: string) => {
      if (id === 'key-1') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ key: key({ id: 'key-2', label: 'Second bot', revokedAt: Date.parse('2026-07-03T00:00:00Z') }) });
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    await screen.findByText('Second bot');

    // Arm + confirm the first row — its revoke call hangs (not yet resolved).
    const firstRevokeButton = screen.getAllByText('Revoke')[0];
    expect(firstRevokeButton).toBeDefined();
    fireEvent.click(firstRevokeButton as HTMLElement);
    fireEvent.click(screen.getByText('Confirm revoke'));
    await waitFor(() => expect(mockRevokeApiKey).toHaveBeenCalledWith('key-1'));

    // Arm + confirm the second row while the first is still in flight. Only
    // one "Revoke" button remains (row 1 is now showing its confirm UI).
    const secondRevokeButton = screen.getAllByText('Revoke')[0];
    expect(secondRevokeButton).toBeDefined();
    fireEvent.click(secondRevokeButton as HTMLElement);
    fireEvent.click(screen.getByText('Confirm revoke'));
    await waitFor(() => expect(mockRevokeApiKey).toHaveBeenCalledWith('key-2'));

    // Row 2 finishing must not resurrect row 1's plain "Revoke" button or
    // otherwise clear row 1's still-pending confirm state. Row 1's confirm
    // button itself now reads "Revoking" (it's genuinely busy), so assert on
    // the stable confirm-panel copy rather than the label that flips to busy
    // text — and assert the plain (non-armed) "Revoke" button is gone from
    // that row.
    await screen.findByText('Revoked');
    const row1 = screen.queryByText('CI bot')?.closest('li') as HTMLElement;
    expect(within(row1).getByText(/can't be undone/i)).toBeTruthy();
    expect(within(row1).queryByText('Revoke')).toBeNull();

    // Now let row 1 resolve too.
    resolveFirst?.({ key: key({ id: 'key-1', revokedAt: Date.parse('2026-07-04T00:00:00Z') }) });
    await waitFor(() => expect(screen.getAllByText('Revoked').length).toBe(2));
  });
});
