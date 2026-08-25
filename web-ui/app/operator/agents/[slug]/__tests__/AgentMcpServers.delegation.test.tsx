import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type { McpDelegation, McpServerNode } from '../../../../_lib/agentBuilder';
import type { AgentGrantsDto } from '../../../../_lib/agents';
import { AgentMcpServers } from '../_components/AgentMcpServers';

/**
 * Issue #862 (epic #860) — delegation choice per agent-MCP assignment.
 *
 * The W0c schema-fit gate decided delegation stays PER SERVER
 * (`mcp_servers.delegation`, migration 0031): there is no per-(agent, server)
 * delegation storage, so the assignment row shows the SERVER's mode and
 * switches it via the existing server-level endpoint — a change with a
 * server-wide effect the UI must label before the operator confirms it.
 */

const {
  mockListMcpServers,
  mockGetAgentGrants,
  mockGetMcpAuthStatus,
  mockSetMcpServerDelegation,
} = vi.hoisted(() => ({
  mockListMcpServers: vi.fn(),
  mockGetAgentGrants: vi.fn(),
  mockGetMcpAuthStatus: vi.fn(),
  mockSetMcpServerDelegation: vi.fn(),
}));

// Spread the real modules so types/parsers (parseMcpGrantErrorCode) stay
// genuine; only the network calls are stubbed.
vi.mock('../../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentBuilder')>()),
  listMcpServers: mockListMcpServers,
  getMcpAuthStatus: mockGetMcpAuthStatus,
  setMcpServerDelegation: mockSetMcpServerDelegation,
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentGrants: mockGetAgentGrants,
}));

function server(delegation: McpDelegation | undefined): McpServerNode {
  return {
    id: 'srv-1',
    name: 'odoo-mcp',
    transport: 'http',
    endpoint: 'https://mcp.example/mcp',
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    ...(delegation !== undefined ? { delegation } : {}),
  };
}

const NO_GRANTS: AgentGrantsDto = {
  slug: 'odoo',
  grant_epoch: null,
  tool_grants: [],
  plugin_mcp_grants: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListMcpServers.mockResolvedValue({ servers: [server('service')] });
  mockGetAgentGrants.mockResolvedValue(NO_GRANTS);
  // Unprotected server → the embedded McpAuthSection renders null.
  mockGetMcpAuthStatus.mockResolvedValue({ connected: false, protected: false });
  mockSetMcpServerDelegation.mockResolvedValue({ id: 'srv-1', delegation: 'per_user' });
});

async function renderExpanded(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithIntl(<AgentMcpServers slug="odoo" />);
  await user.click(await screen.findByRole('button', { name: /odoo-mcp/ }));
  await screen.findByText('Identity delegation');
  return user;
}

describe('AgentMcpServers delegation (#862, per-server by the W0c gate)', () => {
  it('shows the server delegation mode with its server-wide scope labelling', async () => {
    await renderExpanded();

    // Mode in the assignment row (badge in the header + expanded block).
    expect(screen.getAllByText('Service').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(
        'Server-wide setting — it applies to every agent using this server, not just this one.',
      ),
    ).toBeTruthy();
  });

  it('shows the fail-closed identity note for a per_user server', async () => {
    mockListMcpServers.mockResolvedValue({ servers: [server('per_user')] });
    await renderExpanded();

    expect(
      screen.getByText(
        "Per-user calls act under each user's own identity and fail closed when none can be resolved.",
      ),
    ).toBeTruthy();
  });

  it('switches the mode only after the server-wide-effect dialog is confirmed', async () => {
    const user = await renderExpanded();

    await user.click(screen.getByRole('button', { name: 'Switch to per user…' }));
    // Nothing happens until the operator confirms the global effect.
    expect(mockSetMcpServerDelegation).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        '"odoo-mcp" delegates identity per server, not per assignment. Switching to Per user changes it for every agent using this server. Continue?',
      ),
    ).toBeTruthy();

    // The post-switch refresh serves the flipped mode.
    mockListMcpServers.mockResolvedValue({ servers: [server('per_user')] });
    await user.click(screen.getByRole('button', { name: 'Switch mode' }));

    await waitFor(() =>
      expect(mockSetMcpServerDelegation).toHaveBeenCalledWith('srv-1', 'per_user'),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch to service…' })).toBeTruthy(),
    );
  });

  it('does not switch when the dialog is cancelled', async () => {
    const user = await renderExpanded();

    await user.click(screen.getByRole('button', { name: 'Switch to per user…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(mockSetMcpServerDelegation).not.toHaveBeenCalled();
  });

  it('maps a rejected switch to the localized error code message, never the raw body', async () => {
    mockSetMcpServerDelegation.mockRejectedValue(
      new ApiError(400, 'Bad Request', '{"error":"invalid_delegation"}'),
    );
    const user = await renderExpanded();

    await user.click(screen.getByRole('button', { name: 'Switch to per user…' }));
    await user.click(await screen.findByRole('button', { name: 'Switch mode' }));

    expect(await screen.findByText('The server rejected the delegation mode.')).toBeTruthy();
    expect(screen.queryByText('{"error":"invalid_delegation"}')).toBeNull();
  });

  it('renders no delegation UI when the middleware does not report a mode', async () => {
    mockListMcpServers.mockResolvedValue({ servers: [server(undefined)] });
    const user = userEvent.setup();
    renderWithIntl(<AgentMcpServers slug="odoo" />);
    await user.click(await screen.findByRole('button', { name: /odoo-mcp/ }));

    // Older middleware without `delegation` on the server row → no block, no switch.
    await screen.findByText(
      'No tools discovered yet — run discovery in the MCP Control Center first.',
    );
    expect(screen.queryByText('Identity delegation')).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
  });
});
