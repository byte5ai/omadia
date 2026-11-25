import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getMcpAuthStatus, type McpAuthStatus } from '@/app/_lib/agentBuilder';

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
