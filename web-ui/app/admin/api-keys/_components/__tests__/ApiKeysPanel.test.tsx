import { fireEvent, screen, waitFor } from '@testing-library/react';
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

    fireEvent.click(screen.getByText(/dismiss/i));
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
});
