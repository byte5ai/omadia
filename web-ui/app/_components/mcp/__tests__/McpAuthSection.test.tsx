import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disconnectMcpServer,
  getMcpAuthStatus,
  setMcpServerDelegation,
  type McpAuthStatus,
  type McpRevocationOutcome,
} from '@/app/_lib/agentBuilder';

import { renderWithIntl } from '../../../_lib/test-utils';
import { McpAuthSection } from '../McpAuthSection';

vi.mock('@/app/_lib/agentBuilder', () => ({
  authorizeMcpServer: vi.fn(),
  disconnectMcpServer: vi.fn(),
  getMcpAuthStatus: vi.fn(),
  setMcpOAuthClient: vi.fn(),
  setMcpServerDelegation: vi.fn(),
}));

const mockGetAuthStatus = vi.mocked(getMcpAuthStatus);
const mockDisconnect = vi.mocked(disconnectMcpServer);

function status(overrides: Partial<McpAuthStatus> = {}): McpAuthStatus {
  return {
    protected: true,
    connected: false,
    issuer: 'https://as.example',
    issuerHost: 'as.example',
    brokered: true,
    acquisitionMode: 'dcr',
    needsClient: false,
    ...overrides,
  };
}

describe('McpAuthSection status row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a working token: authorized, with Disconnect only', async () => {
    mockGetAuthStatus.mockResolvedValue(status({ connected: true, tokenInvalid: null }));
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);

    expect(await screen.findByText('🔓 Authorized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('no token: not authorized, with Connect only', async () => {
    mockGetAuthStatus.mockResolvedValue(status());
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);

    expect(await screen.findByText('🔒 Not authorized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('a dead token: says the authorization expired and offers Connect', async () => {
    mockGetAuthStatus.mockResolvedValue(status({ connected: false, tokenInvalid: 'rejected' }));
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);

    expect(await screen.findByText('⚠️ Authorization expired')).toBeInTheDocument();
    expect(screen.queryByText('🔓 Authorized')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    // The dead token is still stored, so it can still be removed.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});

describe('McpAuthSection disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Render connected, click Disconnect, and let the status come back empty. */
  async function disconnectWith(revocation: McpRevocationOutcome): Promise<void> {
    mockGetAuthStatus
      .mockResolvedValueOnce(status({ connected: true }))
      .mockResolvedValue(status());
    mockDisconnect.mockResolvedValue({ revocation });
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('🔒 Not authorized')).toBeInTheDocument();
  }

  it('confirms when the provider revoked the access', async () => {
    await disconnectWith('revoked');
    expect(screen.getByText(/as\.example has revoked the access/)).toBeInTheDocument();
  });

  it('says so when the provider offers no revocation', async () => {
    await disconnectWith('unsupported');
    expect(screen.getByText(/offers no way to revoke the access from here/)).toBeInTheDocument();
    expect(screen.getByText(/account settings at as\.example/)).toBeInTheDocument();
  });

  it('says so when the provider did not confirm the revocation', async () => {
    await disconnectWith('failed');
    expect(screen.getByText(/did not confirm that the access is revoked/)).toBeInTheDocument();
  });
});

const SWITCH_TO_SERVICE = 'Use a shared service identity';

describe('McpAuthSection delegation and discovery states (W09-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('#1906 — shows the delegation switch for a server without OAuth', async () => {
    mockGetAuthStatus.mockResolvedValue(status({ protected: false, delegation: 'per_user' }));
    renderWithIntl(<McpAuthSection serverId="s1" />);
    expect(await screen.findByText(SWITCH_TO_SERVICE)).toBeInTheDocument();
  });

  it('#1933 — switching to service asks first and sends the confirmation', async () => {
    const mockSet = vi.mocked(setMcpServerDelegation);
    mockSet.mockResolvedValue({ id: 's1', delegation: 'service' });
    mockGetAuthStatus.mockResolvedValue(status({ delegation: 'per_user' }));
    renderWithIntl(<McpAuthSection serverId="s1" />);
    await userEvent.click(await screen.findByText(SWITCH_TO_SERVICE));
    expect(mockSet).not.toHaveBeenCalled();
    expect(screen.getByText('Share one authorization for every caller?')).toBeInTheDocument();
    const dialogButtons = screen.getAllByRole('button', { name: SWITCH_TO_SERVICE });
    await userEvent.click(dialogButtons[dialogButtons.length - 1]!);
    expect(mockSet).toHaveBeenCalledWith('s1', 'service', { confirm: true });
  });

  it('#1933 — under service the authorization reads as shared, and Disconnect asks first', async () => {
    mockGetAuthStatus.mockResolvedValue(
      status({ connected: true, delegation: 'service', sharedAuthorization: true }),
    );
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);
    expect(await screen.findByText('🔓 Authorized (shared service authorization)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(screen.getByText('Remove the shared authorization?')).toBeInTheDocument();
  });

  it('#1924 — names an unusable provider configuration and drops the placeholders', async () => {
    mockGetAuthStatus.mockResolvedValue(
      status({ issuer: null, issuerHost: null, brokered: false, acquisitionMode: 'manual', discoveryError: 'metadata claims a different issuer' }),
    );
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);
    expect(
      await screen.findByText("The OAuth provider configuration can't be used: metadata claims a different issuer"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\?/)).not.toBeInTheDocument();
  });

  it('#1924 — says the metadata is unreadable right now', async () => {
    mockGetAuthStatus.mockResolvedValue(status({ issuer: null, issuerHost: null, discoveryUnavailable: true }));
    renderWithIntl(<McpAuthSection serverId="s1" showDelegation={false} />);
    expect(
      await screen.findByText("The provider's OAuth metadata can't be read right now. Try again later."),
    ).toBeInTheDocument();
  });
});
