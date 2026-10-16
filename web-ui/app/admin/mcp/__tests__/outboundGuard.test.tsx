import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import type { McpServerNode } from '../../../_lib/agentBuilder';
import { apiErrorBodyMessage, catalogErrorKind, mcpGuardCode } from '../mcpErrors';
import AdminMcpPage from '../page';

/**
 * Issues #1341 / #1342 — the middleware's outbound guard refuses link-local /
 * cloud-metadata hosts (`blocked_host`) and, when MCP_STDIO_ENABLED=false,
 * stdio servers (`stdio_disabled`). The UI must name the rule instead of
 * claiming the host is "down", must not offer a retry that can never succeed,
 * and must surface the route's `message` rather than "POST … failed: 502".
 */

const {
  mockListMcpServers,
  mockDiscoverMcpTools,
  mockCreateMcpServer,
  mockListMcpRegistries,
  mockSearchMcpCatalog,
} = vi.hoisted(() => ({
  mockListMcpServers: vi.fn(),
  mockDiscoverMcpTools: vi.fn(),
  mockCreateMcpServer: vi.fn(),
  mockListMcpRegistries: vi.fn(),
  mockSearchMcpCatalog: vi.fn(),
}));

vi.mock('../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentBuilder')>()),
  listMcpServers: mockListMcpServers,
  discoverMcpTools: mockDiscoverMcpTools,
  createMcpServer: mockCreateMcpServer,
  listMcpRegistries: mockListMcpRegistries,
  searchMcpCatalog: mockSearchMcpCatalog,
}));

const SERVER = {
  id: 'srv-1',
  name: 'pg-probe',
  transport: 'http',
  endpoint: 'http://postgres:5432/',
  status: 'enabled',
  lastDiscoveredAt: null,
  discoveredTools: [],
} as unknown as McpServerNode;

function apiError(status: number, path: string, body: Record<string, unknown>): ApiError {
  return new ApiError(status, `${path} failed: ${status}`, JSON.stringify(body));
}

const BLOCKED_REASON = 'link-local/metadata address refused: 169.254.169.254';

beforeEach(() => {
  vi.clearAllMocks();
  mockListMcpServers.mockResolvedValue({ servers: [SERVER] });
  mockListMcpRegistries.mockResolvedValue({
    registries: [{ id: 'reg-1', name: 'ssrf-test', url: 'http://169.254.169.254/catalog' }],
  });
});

async function openMarketplace(): Promise<void> {
  const user = userEvent.setup();
  renderWithIntl(<AdminMcpPage />);
  await user.click(screen.getByRole('button', { name: 'Marketplace' }));
  await waitFor(() => expect(mockSearchMcpCatalog).toHaveBeenCalled());
}

describe('mcpErrors helpers', () => {
  it('reads the JSON body message, and returns null without one', () => {
    expect(apiErrorBodyMessage(apiError(502, 'GET /x', { message: 'boom' }))).toBe('boom');
    expect(apiErrorBodyMessage(new ApiError(502, 'GET /x failed: 502', 'not json'))).toBeNull();
    expect(apiErrorBodyMessage(new Error('plain'))).toBeNull();
  });

  it('classifies blocked_host apart from transport failures', () => {
    expect(catalogErrorKind(apiError(502, 'GET /c', { code: 'blocked_host' }))).toBe('blocked');
    expect(catalogErrorKind(apiError(502, 'GET /c', { code: 'transport_failed' }))).toBe('unreachable');
    expect(catalogErrorKind(apiError(502, 'GET /c', { code: 'timeout' }))).toBe('timeout');
    expect(catalogErrorKind(apiError(502, 'GET /c', { code: 'http_error' }))).toBe('generic');
  });

  it('recognises only the two guard codes', () => {
    expect(mcpGuardCode(apiError(400, 'POST /s', { code: 'stdio_disabled' }))).toBe('stdio_disabled');
    expect(mcpGuardCode(apiError(400, 'POST /s', { code: 'blocked_host' }))).toBe('blocked_host');
    expect(mcpGuardCode(apiError(502, 'POST /s', { code: 'transport_failed' }))).toBeNull();
  });
});

describe('Marketplace catalog failure card (#1341)', () => {
  it('explains a blocked_host refusal, shows the guard reason, and offers no retry', async () => {
    mockSearchMcpCatalog.mockRejectedValue(
      apiError(502, 'GET /v1/operator/mcp-registries/reg-1/catalog', {
        error: 'mcp_registry_unreachable',
        code: 'blocked_host',
        message: BLOCKED_REASON,
      }),
    );
    await openMarketplace();

    expect(await screen.findByText('The registry "ssrf-test" is blocked for security reasons.')).toBeTruthy();
    expect(screen.getByText(/must not point at a link-local or cloud-metadata address/)).toBeTruthy();
    expect(screen.getByText(`Details: ${BLOCKED_REASON}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(/could not be reached/)).toBeNull();
  });

  it('shows the server message for transport_failed and keeps Try again', async () => {
    const reason = 'http://postgres:5432 could not be reached: TypeError: fetch failed';
    mockSearchMcpCatalog.mockRejectedValue(
      apiError(502, 'GET /v1/operator/mcp-registries/reg-1/catalog', {
        error: 'mcp_registry_unreachable',
        code: 'transport_failed',
        message: reason,
      }),
    );
    await openMarketplace();

    expect(await screen.findByText('The registry "ssrf-test" could not be reached.')).toBeTruthy();
    expect(screen.getByText(`Details: ${reason}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Servers tab guard errors (#1341 / #1342)', () => {
  it('shows the discover body message instead of the bare status line', async () => {
    const user = userEvent.setup();
    mockDiscoverMcpTools.mockRejectedValue(
      apiError(502, 'POST /v1/operator/mcp-servers/srv-1/discover', {
        error: 'mcp_discover_failed',
        message: 'Version negotiation probe failed: fetch failed',
      }),
    );
    renderWithIntl(<AdminMcpPage />);
    await user.click(await screen.findByRole('button', { name: 'Discover' }));

    expect(await screen.findByText('Version negotiation probe failed: fetch failed')).toBeTruthy();
    expect(screen.queryByText(/failed: 502/)).toBeNull();
  });

  it('explains a discover refused because stdio is disabled', async () => {
    const user = userEvent.setup();
    mockDiscoverMcpTools.mockRejectedValue(
      apiError(502, 'POST /v1/operator/mcp-servers/srv-1/discover', {
        error: 'mcp_discover_failed',
        code: 'stdio_disabled',
        message: 'stdio MCP servers are disabled on this installation (MCP_STDIO_ENABLED=false)',
      }),
    );
    renderWithIntl(<AdminMcpPage />);
    await user.click(await screen.findByRole('button', { name: 'Discover' }));

    expect(await screen.findByText(/Use a remote \(http\) server instead/)).toBeTruthy();
  });

  it('explains a create refused for a blocked host, with the guard reason', async () => {
    const user = userEvent.setup();
    mockCreateMcpServer.mockRejectedValue(
      apiError(400, 'POST /v1/operator/mcp-servers', {
        error: 'mcp_endpoint_refused',
        code: 'blocked_host',
        message: BLOCKED_REASON,
      }),
    );
    renderWithIntl(<AdminMcpPage />);
    await user.click(await screen.findByRole('button', { name: 'Add server' }));

    const line = await screen.findByText(/This address is blocked for security reasons/);
    expect(line.textContent).toContain(BLOCKED_REASON);
    expect(line.textContent).toContain('private and intranet addresses are allowed');
  });

  it('shows the stdio permission hint only while stdio is selected', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminMcpPage />);
    const select = (await screen.findByLabelText('Transport')) as HTMLSelectElement;

    expect(screen.queryByText(/MCP_STDIO_ENABLED=false/)).toBeNull();
    await user.selectOptions(select, 'stdio');
    expect(screen.getByText(/runs as a process inside the middleware container/)).toBeTruthy();
  });
});
