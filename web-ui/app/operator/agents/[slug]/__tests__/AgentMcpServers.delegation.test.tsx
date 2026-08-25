import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { McpDelegation, McpServerNode } from '../../../../_lib/agentBuilder';
import type { AgentGrantsDto } from '../../../../_lib/agents';
import { AgentMcpServers } from '../_components/AgentMcpServers';

/**
 * Issue #862 (epic #860) — delegation on the agent-MCP assignment row.
 *
 * The W0c schema-fit gate decided delegation stays PER SERVER
 * (`mcp_servers.delegation`, migration 0031): there is no per-(agent, server)
 * delegation storage. The coordinator's follow-up ruling for the assignment
 * view: the row shows the SERVER's mode READ-ONLY, labels its server-wide
 * effect, and links to the MCP server settings — the single write surface.
 * There must be NO delegation write path on the agent detail page, including
 * the one McpAuthSection normally embeds (it is passed showDelegation={false}).
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

describe('AgentMcpServers delegation (#862, read-only per the W0c ruling)', () => {
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

  it('is strictly read-only — no switch control, and the mode write is never called', async () => {
    await renderExpanded();

    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch mode' })).toBeNull();
    expect(mockSetMcpServerDelegation).not.toHaveBeenCalled();
  });

  it('links to the MCP server settings, the single delegation write surface', async () => {
    await renderExpanded();

    const link = screen.getByRole('link', { name: 'Change in MCP server settings' });
    expect(link.getAttribute('href')).toBe('/admin/mcp');
  });

  it('suppresses McpAuthSection\'s own delegation toggle on this page (one surface per context)', async () => {
    // A protected server WITH auth-status delegation would normally render
    // McpAuthSection's un-gated switch — the agent page passes
    // showDelegation={false}, so no second (and un-labelled) delegation
    // control can appear here.
    mockGetMcpAuthStatus.mockResolvedValue({
      connected: true,
      protected: true,
      delegation: 'service',
      identityResolved: true,
    });
    await renderExpanded();

    expect(screen.queryByText('Acting identity')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Require per-user identity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use a shared service identity' })).toBeNull();
  });

  it('renders no delegation UI when the middleware does not report a mode', async () => {
    mockListMcpServers.mockResolvedValue({ servers: [server(undefined)] });
    const user = userEvent.setup();
    renderWithIntl(<AgentMcpServers slug="odoo" />);
    await user.click(await screen.findByRole('button', { name: /odoo-mcp/ }));

    // Middleware builds without `delegation` on the server row → no block.
    await screen.findByText(
      'No tools discovered yet — run discovery in the MCP Control Center first.',
    );
    expect(screen.queryByText('Identity delegation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change in MCP server settings' })).toBeNull();
  });
});
