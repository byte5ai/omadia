import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiKeysPanel } from '../ApiKeysPanel';
import type { ApiKeyPublicView } from '../../../../_lib/api';

const {
  mockListApiKeys,
  mockCreateApiKey,
  mockRevokeApiKey,
  mockDeleteApiKey,
  mockListApiKeyScopes,
  mockListApiKeyUsage,
} = vi.hoisted(() => ({
  mockListApiKeys: vi.fn(),
  mockCreateApiKey: vi.fn(),
  mockRevokeApiKey: vi.fn(),
  mockDeleteApiKey: vi.fn(),
  mockListApiKeyScopes: vi.fn(),
  mockListApiKeyUsage: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  listApiKeys: mockListApiKeys,
  createApiKey: mockCreateApiKey,
  revokeApiKey: mockRevokeApiKey,
  deleteApiKey: mockDeleteApiKey,
  listApiKeyScopes: mockListApiKeyScopes,
  listApiKeyUsage: mockListApiKeyUsage,
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
    mockDeleteApiKey.mockResolvedValue(undefined);
    mockListApiKeyScopes.mockResolvedValue({
      scopes: ['chat:write', 'mcp:list', 'mcp:invoke', '*'],
      mcpWritePrefix: 'mcp:write:',
    });
    mockListApiKeyUsage.mockResolvedValue({ entries: [] });
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

    // #1328 — inactive keys are hidden until the operator asks for them.
    fireEvent.click(await screen.findByText(/Show revoked and expired keys/));
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

  it('blocks submission and explains why when no scope is selected', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(await screen.findByRole('checkbox', { name: /chat:write/ }));

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

  // Regression guard for the `reloadSeqRef` sequence check: only the most
  // recently ISSUED list request may write state. A slow mount fetch that
  // resolves AFTER a post-create reload describes a world without the key the
  // operator just minted — applying it makes that key vanish from the table
  // seconds after it appeared, with no error and no way to get it back except
  // a manual refresh.
  it('discards a stale list response that resolves after a newer reload', async () => {
    let resolveStaleMount: ((v: { keys: ApiKeyPublicView[] }) => void) | undefined;
    mockListApiKeys
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleMount = resolve;
          }),
      )
      .mockResolvedValue({ keys: [key({ id: 'key-new', label: 'Freshly minted' })] });
    mockCreateApiKey.mockResolvedValue({
      key: key({ id: 'key-new', label: 'Freshly minted' }),
      token: 'sk-live-plaintext-token-value',
    });
    renderWithIntl(<ApiKeysPanel />);

    // Reload #1 (mount) is issued and left hanging.
    await waitFor(() => expect(mockListApiKeys).toHaveBeenCalledTimes(1));

    // Creating issues reload #2, which wins the race and paints the new key.
    fireEvent.click(screen.getByText('Create key'));
    expect(await screen.findByText('Freshly minted')).toBeTruthy();
    await waitFor(() => expect(mockListApiKeys).toHaveBeenCalledTimes(2));

    // Reload #1 finally answers — with a list that predates the new key. It is
    // stale by construction and must be dropped on the floor.
    resolveStaleMount?.({ keys: [key({ id: 'key-stale', label: 'Stale ghost' })] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('Stale ghost')).toBeNull();
    expect(screen.getByText('Freshly minted')).toBeTruthy();
  });
  // #1324 — the hint says "dismiss the token ABOVE", so the token banner must
  // render before the (locked) create form.
  it('renders the one-time token banner above the create form', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockCreateApiKey.mockResolvedValue({ key: key(), token: 'sk-live-plaintext-token-value' });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.click(screen.getByText('Create key'));
    const token = await screen.findByText('sk-live-plaintext-token-value');
    const hint = screen.getByText(/Dismiss the token above/i);
    // DOCUMENT_POSITION_FOLLOWING: the hint comes after the token.
    expect(token.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // #1327 — every catalog scope is offered, including the MCP ones, plus
  // per-tool write scopes.
  it('offers every catalog scope and sends MCP scopes and write tools on create', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockCreateApiKey.mockResolvedValue({ key: key(), token: 'tok' });
    renderWithIntl(<ApiKeysPanel />);

    for (const scope of ['chat:write', 'mcp:list', 'mcp:invoke', '*']) {
      expect(await screen.findByRole('checkbox', { name: new RegExp(scope.replace('*', '\\*')) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /chat:write/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /mcp:list/ }));
    fireEvent.change(screen.getByLabelText(/^Write tools/), {
      target: { value: 'create_lead, update_lead' },
    });
    fireEvent.click(screen.getByText('Create key'));

    await waitFor(() => expect(mockCreateApiKey).toHaveBeenCalledTimes(1));
    expect(mockCreateApiKey.mock.calls[0]?.[0].scopes).toEqual([
      'mcp:list',
      'mcp:write:create_lead',
      'mcp:write:update_lead',
    ]);
  });

  it('rejects a malformed write-tool name before sending', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText(/No API keys yet/i);
    fireEvent.change(screen.getByLabelText(/^Write tools/), { target: { value: 'Bad Tool' } });
    expect(screen.getByText('Create key')).toHaveProperty('disabled', true);
    expect(screen.getByText(/Tool names may contain only/i)).toBeTruthy();
  });

  it('falls back to chat:write and says so when the scope catalog cannot be loaded', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] });
    mockListApiKeyScopes.mockRejectedValue(new Error('offline'));
    renderWithIntl(<ApiKeysPanel />);

    expect(await screen.findByText(/scope list could not be loaded/i)).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  // #1328 — owner, expiry and last-used are shown on the row.
  it('shows the creator, the expiry and when the key was last used', async () => {
    mockListApiKeys.mockResolvedValue({
      keys: [
        key({
          createdBy: { email: 'op@example.com' },
          expiresAt: Date.now() + 86_400_000,
          lastUsedAt: Date.parse('2026-07-05T00:00:00Z'),
        }),
      ],
    });
    renderWithIntl(<ApiKeysPanel />);

    const row = (await screen.findByText(/Created by op@example.com/)).closest('li') as HTMLElement;
    expect(within(row).getByText(/Last used/)).toBeTruthy();
    expect(within(row).getByText(/Expires/)).toBeTruthy();
  });

  it('hides revoked and expired keys behind a toggle and lets them be deleted', async () => {
    mockListApiKeys.mockResolvedValue({
      keys: [
        key(),
        key({ id: 'key-old', label: 'Old bot', expiresAt: Date.now() - 1000 }),
      ],
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    expect(screen.queryByText('Old bot')).toBeNull();
    fireEvent.click(screen.getByText(/Show revoked and expired keys \(1\)/));

    const row = (await screen.findByText('Old bot')).closest('li') as HTMLElement;
    expect(within(row).getByText('Expired')).toBeTruthy();
    expect(within(row).queryByText('Revoke')).toBeNull();
    fireEvent.click(within(row).getByText('Delete'));
    expect(mockDeleteApiKey).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByText('Confirm delete'));

    await waitFor(() => expect(mockDeleteApiKey).toHaveBeenCalledWith('key-old'));
    await waitFor(() => expect(screen.queryByText('Old bot')).toBeNull());
  });

  // #1329 — the per-key usage log is readable from the row.
  it('loads and shows a key\'s recent activity on demand', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [key()] });
    mockListApiKeyUsage.mockResolvedValue({
      entries: [
        { keyId: 'key-1', route: '/api/public/v1/chat', method: 'POST', at: Date.now(), status: 'forbidden' },
      ],
    });
    renderWithIntl(<ApiKeysPanel />);

    await screen.findByText('CI bot');
    fireEvent.click(screen.getByText('Recent activity'));
    expect(await screen.findByText('Missing scope')).toBeTruthy();
    expect(screen.getByText(/POST \/api\/public\/v1\/chat/)).toBeTruthy();
    expect(mockListApiKeyUsage).toHaveBeenCalledWith('key-1');
  });
});
