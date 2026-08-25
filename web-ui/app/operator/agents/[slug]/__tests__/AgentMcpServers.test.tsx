import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type {
  McpDiscoveredTool,
  McpServerNode,
  McpToolVerdictField,
} from '../../../../_lib/agentBuilder';
import type { AgentGrantsDto } from '../../../../_lib/agents';
import { AgentMcpServers } from '../_components/AgentMcpServers';

/**
 * Issue #862 (epic #860) — per-agent MCP server assignment + tool allowlist
 * editor. The allowlist IS the agent's `agent_tool_grants` rows for the
 * server; the editor must mirror the middleware's fail-closed verdict gate:
 * a not-yet-acked high-risk tool and a never-scanned tool stay ungrantable
 * in the UI too (the backend rejects them as 409 `config_validation`).
 */

const {
  mockListMcpServers,
  mockGetAgentGrants,
  mockReplaceMcpToolAllowlist,
  mockAckMcpToolVerdict,
  mockGetMcpAuthStatus,
} = vi.hoisted(() => ({
  mockListMcpServers: vi.fn(),
  mockGetAgentGrants: vi.fn(),
  mockReplaceMcpToolAllowlist: vi.fn(),
  mockAckMcpToolVerdict: vi.fn(),
  mockGetMcpAuthStatus: vi.fn(),
}));

// Spread the real modules so types/parsers (parseMcpGrantErrorCode) stay
// genuine; only the network calls are stubbed.
vi.mock('../../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentBuilder')>()),
  listMcpServers: mockListMcpServers,
  replaceMcpToolAllowlist: mockReplaceMcpToolAllowlist,
  ackMcpToolVerdict: mockAckMcpToolVerdict,
  getMcpAuthStatus: mockGetMcpAuthStatus,
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentGrants: mockGetAgentGrants,
}));

function verdict(overrides: Partial<McpToolVerdictField>): McpToolVerdictField {
  return {
    severity: 'no_signals',
    riskCodes: [],
    notYetScanned: false,
    acked: false,
    ackStale: false,
    ...overrides,
  };
}

function tool(name: string, v: McpToolVerdictField | undefined): McpDiscoveredTool {
  return { name, description: `${name} tool`, verdict: v };
}

const SAFE_GRANTED = tool('search_partners', verdict({}));
const SAFE_UNGRANTED = tool('create_invoice', verdict({}));
const HIGH_RISK = tool(
  'execute_sql',
  verdict({ severity: 'high_risk', riskCodes: ['exec'] }),
);
const UNSCANNED = tool('later_tool', verdict({ severity: null, notYetScanned: true }));

function server(overrides: Partial<McpServerNode> = {}): McpServerNode {
  return {
    id: 'srv-1',
    name: 'odoo-mcp',
    transport: 'http',
    endpoint: 'https://mcp.example/mcp',
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [SAFE_GRANTED, SAFE_UNGRANTED, HIGH_RISK, UNSCANNED],
    ...overrides,
  };
}

function grants(toolRefs: string[]): AgentGrantsDto {
  return {
    slug: 'odoo',
    grant_epoch: null,
    tool_grants: toolRefs.map((ref, i) => ({
      id: `g-${i}`,
      tool_kind: 'mcp' as const,
      tool_ref: ref,
      sub_agent_id: null,
      mcp_server_id: 'srv-1',
      server_name: 'odoo-mcp',
      grant_epoch: null,
      created_at: '2026-08-25T00:00:00Z',
    })),
    plugin_mcp_grants: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListMcpServers.mockResolvedValue({ servers: [server()] });
  mockGetAgentGrants.mockResolvedValue(grants(['search_partners']));
  // Unprotected server → the embedded McpAuthSection renders null.
  mockGetMcpAuthStatus.mockResolvedValue({ connected: false, protected: false });
  mockReplaceMcpToolAllowlist.mockResolvedValue({
    agentSlug: 'odoo',
    mcpServerId: 'srv-1',
    toolNames: [],
    granted: [],
    revoked: [],
    delegation: 'service',
    delegationScope: 'server',
  });
});

async function renderExpanded(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithIntl(<AgentMcpServers slug="odoo" />);
  await user.click(await screen.findByRole('button', { name: /odoo-mcp/ }));
  await screen.findByLabelText('Grant search_partners');
  return user;
}

describe('AgentMcpServers (#862)', () => {
  it('lists the server with its granted-tool count and discovered tools', async () => {
    await renderExpanded();

    expect(screen.getByText('1 of 4 tools granted')).toBeTruthy();
    expect(screen.getByText('Discovered tools (4)')).toBeTruthy();
    expect((screen.getByLabelText('Grant search_partners') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Grant create_invoice') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a not-yet-acked high-risk tool and an unscanned tool ungrantable (fail-closed)', async () => {
    await renderExpanded();

    expect((screen.getByLabelText('Grant execute_sql') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Grant later_tool') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Grant create_invoice') as HTMLInputElement).disabled).toBe(false);
    expect(
      screen.getByText('The scan verdict must be acknowledged before this tool can be granted.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Not scanned yet — unscanned tools cannot be granted.'),
    ).toBeTruthy();
  });

  it('acks a high-risk verdict via the two-step button and unlocks the tool', async () => {
    mockAckMcpToolVerdict.mockResolvedValue({
      severity: 'high_risk',
      acked: true,
      ackedBy: 'operator',
      ackedAt: '2026-08-25T00:00:00Z',
    });
    const user = await renderExpanded();

    // First click arms, second click fires — no accidental one-click acks.
    await user.click(screen.getByRole('button', { name: 'Acknowledge verdict' }));
    expect(mockAckMcpToolVerdict).not.toHaveBeenCalled();

    // The post-ack refresh serves the acked verdict.
    const ackedServer = server({
      discoveredTools: [
        SAFE_GRANTED,
        SAFE_UNGRANTED,
        tool('execute_sql', verdict({ severity: 'high_risk', riskCodes: ['exec'], acked: true })),
        UNSCANNED,
      ],
    });
    mockListMcpServers.mockResolvedValue({ servers: [ackedServer] });

    await user.click(screen.getByRole('button', { name: 'Confirm acknowledge' }));

    await waitFor(() =>
      expect(mockAckMcpToolVerdict).toHaveBeenCalledWith('srv-1', 'execute_sql'),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Grant execute_sql') as HTMLInputElement).disabled).toBe(false),
    );
  });

  it('saves the edited allowlist as one bulk replace with the sorted tool names', async () => {
    mockReplaceMcpToolAllowlist.mockResolvedValue({
      agentSlug: 'odoo',
      mcpServerId: 'srv-1',
      toolNames: ['create_invoice', 'search_partners'],
      granted: ['create_invoice'],
      revoked: [],
      delegation: 'service',
      delegationScope: 'server',
    });
    const user = await renderExpanded();

    await user.click(screen.getByLabelText('Grant create_invoice'));
    await user.click(screen.getByRole('button', { name: 'Save allowlist' }));

    await waitFor(() =>
      expect(mockReplaceMcpToolAllowlist).toHaveBeenCalledWith('odoo', 'srv-1', [
        'create_invoice',
        'search_partners',
      ]),
    );
    expect(await screen.findByText('Allowlist saved — 1 granted, 0 revoked.')).toBeTruthy();
  });

  it('maps a rejected save to the localized error code message, never the raw body', async () => {
    mockReplaceMcpToolAllowlist.mockRejectedValue(
      new ApiError(409, 'Conflict', '{"error":"config_validation"}'),
    );
    const user = await renderExpanded();

    await user.click(screen.getByLabelText('Grant create_invoice'));
    await user.click(screen.getByRole('button', { name: 'Save allowlist' }));

    expect(
      await screen.findByText(
        'The scan gate rejected the change — a selected tool is blocked or not scanned yet.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('{"error":"config_validation"}')).toBeNull();
  });

  it('unassigns the server by replacing the allowlist with the empty set after confirm', async () => {
    const user = await renderExpanded();

    await user.click(screen.getByRole('button', { name: 'Unassign server' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke all' }));

    await waitFor(() =>
      expect(mockReplaceMcpToolAllowlist).toHaveBeenCalledWith('odoo', 'srv-1', []),
    );
  });

  it('shows the empty state when no MCP server exists', async () => {
    mockListMcpServers.mockResolvedValue({ servers: [] });
    mockGetAgentGrants.mockResolvedValue(grants([]));
    renderWithIntl(<AgentMcpServers slug="odoo" />);

    expect(
      await screen.findByText(
        'No MCP servers available. Register and discover servers in the MCP Control Center first.',
      ),
    ).toBeTruthy();
  });
});
