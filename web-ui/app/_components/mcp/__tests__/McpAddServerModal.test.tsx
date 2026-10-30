import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StrictMode } from 'react';

import { ApiError } from '@/app/_lib/api';
import {
  listMcpServers,
  setMcpServerDelegation,
  createMcpServer,
  discoverMcpTools,
  getMcpAuthStatus,
  importMcpServerFromRegistry,
  listMcpRegistries,
  searchMcpCatalog,
  setMcpServerStatus,
  type McpCatalogEntry,
  type McpServerNode,
} from '@/app/_lib/agentBuilder';

import { renderWithIntl } from '../../../_lib/test-utils';
import { McpAddServerModal, type McpAddServerModalProps } from '../McpAddServerModal';

vi.mock('@/app/_lib/agentBuilder', () => ({
  listMcpRegistries: vi.fn(),
  searchMcpCatalog: vi.fn(),
  importMcpServerFromRegistry: vi.fn(),
  createMcpServer: vi.fn(),
  discoverMcpTools: vi.fn(),
  setMcpServerStatus: vi.fn(),
  getMcpAuthStatus: vi.fn(),
  setMcpServerDelegation: vi.fn(),
  listMcpServers: vi.fn(),
}));

vi.mock('../McpAuthSection', () => ({
  McpAuthSection: () => <div data-testid="auth-section" />,
}));

const mockListRegistries = vi.mocked(listMcpRegistries);
const mockSearchCatalog = vi.mocked(searchMcpCatalog);
const mockImportServer = vi.mocked(importMcpServerFromRegistry);
const mockCreateServer = vi.mocked(createMcpServer);
const mockDiscoverTools = vi.mocked(discoverMcpTools);
const mockSetStatus = vi.mocked(setMcpServerStatus);
const mockGetAuthStatus = vi.mocked(getMcpAuthStatus);
const mockSetDelegation = vi.mocked(setMcpServerDelegation);
const mockListServers = vi.mocked(listMcpServers);

const CATALOG_ENTRY: McpCatalogEntry = {
  id: 'e1',
  name: 'Pleo',
  description: 'Pleo tools',
  version: '1.0.0',
  transport: 'http',
  endpoint: 'https://pleo.example/mcp',
  license: null,
  author: null,
  sourceUrl: null,
};

function server(overrides: Partial<McpServerNode> = {}): McpServerNode {
  return {
    id: 's1',
    name: 'Pleo server',
    transport: 'http',
    endpoint: 'https://pleo.example/mcp',
    status: 'disabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    ...overrides,
  };
}

const ENABLED_SERVER = server({ status: 'enabled' });
const DISCOVERED_SERVER = server({
  status: 'enabled',
  delegation: 'service',
  discoveredTools: [
    { name: 'other_tool', description: 'Other' },
    { name: 'list_missing_receipts', description: 'Missing receipts' },
  ],
});

beforeEach(() => {
  mockListServers.mockResolvedValue({ servers: [] });
  vi.clearAllMocks();
  const originalError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!args.map(String).join(' ').includes('MISSING_MESSAGE')) originalError(...args);
  });
  mockListRegistries.mockResolvedValue({
    registries: [{ id: 'r1', name: 'Registry', url: 'https://registry.example', authKind: 'none', hasToken: false }],
  });
  mockSearchCatalog.mockResolvedValue({ entries: [CATALOG_ENTRY] });
  mockImportServer.mockResolvedValue(server());
  mockSetStatus.mockResolvedValue(ENABLED_SERVER);
  mockDiscoverTools.mockResolvedValue(DISCOVERED_SERVER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openRegistryEntry(props: { missingRef?: string; onResolve?: McpAddServerModalProps['onResolve'] } = {}): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithIntl(
    <McpAddServerModal
      initialQuery="pleo"
      missingRef={props.missingRef}
      onResolve={props.onResolve ?? vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => {
    expect(mockSearchCatalog).toHaveBeenCalledWith('r1', 'pleo', {
      signal: expect.any(AbortSignal),
    });
  });
  await user.click(await screen.findByTestId('mcp-add-entry'));
  return user;
}

describe('McpAddServerModal', () => {
  it('searches, imports, enables, discovers, highlights, and resolves a tool', async () => {
    const onResolve = vi.fn();
    const user = await openRegistryEntry({
      missingRef: 'pleo.list_missing_receipts',
      onResolve,
    });

    await waitFor(() => expect(mockImportServer).toHaveBeenCalledWith('r1', 'e1'));
    await waitFor(() => expect(mockSetStatus).toHaveBeenCalledWith('s1', 'enabled'));
    await waitFor(() => expect(mockDiscoverTools).toHaveBeenCalledWith('s1'));
    const [tool] = await screen.findAllByTestId('mcp-add-tool');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('highlighted tool was not rendered');
    expect(tool).toHaveAttribute('data-tool-name', 'list_missing_receipts');
    expect(tool).toHaveAttribute('data-highlighted', 'true');
    await user.click(tool);
    expect(onResolve).toHaveBeenCalledWith({
      serverId: 's1',
      serverName: 'Pleo server',
      toolName: 'list_missing_receipts',
      actionId: 'mcp:s1:list_missing_receipts',
    });
  });

  it('shows authorization and retries discovery after focus reports connected', async () => {
    mockDiscoverTools
      .mockRejectedValueOnce(new ApiError(409, 'POST failed: 409', JSON.stringify({ error: 'mcp_needs_auth', serverId: 's1' })))
      .mockResolvedValueOnce(DISCOVERED_SERVER);
    mockGetAuthStatus.mockResolvedValue({
      protected: true,
      connected: true,
      issuer: null,
      needsClient: false,
    });
    await openRegistryEntry();
    expect(await screen.findByTestId('auth-section')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-add-retry')).toBeInTheDocument();

    fireEvent.focus(window);
    await waitFor(() => expect(mockGetAuthStatus).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(mockDiscoverTools).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByTestId('mcp-add-tool')).toHaveLength(2);
  });

  it('creates a manual enabled server without enabling it again', async () => {
    const user = userEvent.setup();
    mockCreateServer.mockResolvedValue(ENABLED_SERVER);
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByTestId('mcp-add-tab-manual'));
    await user.type(screen.getByTestId('mcp-add-manual-name'), 'Manual server');
    await user.type(screen.getByTestId('mcp-add-manual-endpoint'), 'https://manual.example/mcp');
    await user.click(screen.getByTestId('mcp-add-manual-submit'));

    await waitFor(() => expect(mockCreateServer).toHaveBeenCalledWith({
      name: 'Manual server',
      transport: 'http',
      endpoint: 'https://manual.example/mcp',
    }));
    await waitFor(() => expect(mockDiscoverTools).toHaveBeenCalledWith('s1'));
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('closes on Escape and overlay click', () => {
    const onClose = vi.fn();
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('links config-required discovery errors to the Control Center', async () => {
    mockDiscoverTools.mockRejectedValueOnce(new ApiError(422, 'POST failed: 422', JSON.stringify({ error: 'mcp_config_required', missing: ['API_KEY'] })));
    await openRegistryEntry();
    const link = await screen.findByTestId('mcp-add-config-link');
    expect(link).toHaveAttribute('href', '/admin/mcp?server=s1');
  });

  it('links endpoint-placeholder discovery errors to the Control Center', async () => {
    mockDiscoverTools.mockRejectedValueOnce(new ApiError(422, 'POST failed: 422', JSON.stringify({ error: 'mcp_endpoint_placeholder', placeholders: ['tenant_id'] })));
    await openRegistryEntry();
    expect(await screen.findByTestId('mcp-add-config-link')).toHaveAttribute('href', '/admin/mcp?server=s1');
  });

  it('surfaces a discovery error and succeeds when retry is selected', async () => {
    const user = userEvent.setup();
    mockDiscoverTools.mockRejectedValueOnce(new Error('discovery unavailable')).mockResolvedValueOnce(DISCOVERED_SERVER);
    await openRegistryEntry();
    expect(await screen.findByTestId('mcp-add-connect-error')).toHaveTextContent('discovery unavailable');
    await user.click(screen.getByTestId('mcp-add-retry'));
    await waitFor(() => expect(mockDiscoverTools).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByTestId('mcp-add-tool')).toHaveLength(2);
  });

  it('surfaces registry loading failures', async () => {
    mockListRegistries.mockRejectedValueOnce(new Error('registry unavailable'));
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('registry unavailable')).toBeInTheDocument();
  });

  it('keeps browse-only catalog entries disabled', async () => {
    const user = userEvent.setup();
    mockSearchCatalog.mockResolvedValue({ entries: [{ ...CATALOG_ENTRY, transport: null }] });
    renderWithIntl(<McpAddServerModal initialQuery="pleo" onResolve={vi.fn()} onClose={vi.fn()} />);
    const entry = await screen.findByTestId('mcp-add-entry');
    expect(entry).toBeDisabled();
    await user.click(entry);
    expect(mockImportServer).not.toHaveBeenCalled();
  });

  it('shows the empty-tools state after successful discovery', async () => {
    mockDiscoverTools.mockResolvedValueOnce(server({ status: 'enabled', discoveredTools: [] }));
    await openRegistryEntry();
    expect(await screen.findByTestId('mcp-add-empty-tools')).toBeInTheDocument();
  });
});

describe('McpAddServerModal — delegation gate', () => {
  it('a per_user server blocks tool picking until the operator enables service delegation', async () => {
    mockListRegistries.mockResolvedValue({ registries: [{ id: 'r1', name: 'Official', url: 'https://r', authKind: 'none', hasToken: false }] });
    mockSearchCatalog.mockResolvedValue({ entries: [CATALOG_ENTRY] });
    mockImportServer.mockResolvedValue(server({ status: 'disabled', delegation: 'per_user' }));
    mockSetStatus.mockResolvedValue({ ...ENABLED_SERVER, delegation: 'per_user' } as never);
    mockDiscoverTools.mockResolvedValue({ ...DISCOVERED_SERVER, delegation: 'per_user' });
    mockSetDelegation.mockResolvedValue({ id: 's1', delegation: 'service' });
    const onResolve = vi.fn();
    renderWithIntl(<McpAddServerModal initialQuery="pleo" onResolve={onResolve} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText('Pleo'));

    expect(await screen.findByTestId('mcp-add-delegation')).toBeInTheDocument();
    const tools = await screen.findAllByTestId('mcp-add-tool');
    expect(tools[0]).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Enable service delegation' }));
    expect(mockSetDelegation).toHaveBeenCalledWith('s1', 'service');
    await waitFor(() => expect(screen.queryByTestId('mcp-add-delegation')).not.toBeInTheDocument());
    await userEvent.click(screen.getAllByTestId('mcp-add-tool')[0] as HTMLElement);
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ actionId: expect.stringMatching(/^mcp:s1:/) }));
  });
});

describe('McpAddServerModal — manual endpoint validation', () => {
  it('refuses a scheme-less endpoint before creating anything', async () => {
    mockListRegistries.mockResolvedValue({ registries: [] });
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Manual' }));
    await userEvent.type(screen.getByTestId('mcp-add-manual-name'), 'Pleo');
    await userEvent.type(screen.getByTestId('mcp-add-manual-endpoint'), 'mcp.pleo.io');
    await userEvent.click(screen.getByRole('button', { name: 'Create server' }));
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(await screen.findByText(/absolute http\(s\) URL/)).toBeInTheDocument();
  });
});

describe('McpAddServerModal — connect step under React StrictMode', () => {
  it('shows the discovery error (and leaves busy) even though dev StrictMode double-mounts the step', async () => {
    mockListRegistries.mockResolvedValue({ registries: [] });
    mockCreateServer.mockResolvedValue(server({ status: 'enabled', endpoint: 'https://mcp.example/mcp' }));
    mockDiscoverTools.mockRejectedValue(new ApiError(502, 'POST discover failed: 502', JSON.stringify({ error: 'mcp_discover_failed', message: 'Invalid URL' })));
    renderWithIntl(
      <StrictMode>
        <McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />
      </StrictMode>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Manual' }));
    await userEvent.type(screen.getByTestId('mcp-add-manual-name'), 'Pleo');
    await userEvent.type(screen.getByTestId('mcp-add-manual-endpoint'), 'https://mcp.example/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Create server' }));
    expect(await screen.findByTestId('mcp-add-connect-error')).toHaveTextContent(/Invalid URL/);
    expect(screen.queryByText('Enabling the server and discovering its tools…')).not.toBeInTheDocument();
    expect(screen.getByTestId('mcp-add-retry')).toBeInTheDocument();
  });
});

describe('McpAddServerModal — duplicate name offers the existing server', () => {
  it('on 409 shows "use the existing server" and continues the connect step with that row', async () => {
    mockListRegistries.mockResolvedValue({ registries: [] });
    mockCreateServer.mockRejectedValue(new ApiError(409, 'POST failed: 409', JSON.stringify({ error: 'config_validation', message: 'MCP server "Pleo" already exists' })));
    mockListServers.mockResolvedValue({ servers: [server({ id: 'existing-1', name: 'Pleo', status: 'enabled', delegation: 'service', endpoint: 'https://mcp.pleo.io', discoveredTools: [{ name: 'list_missing_receipts' }] })] });
    mockDiscoverTools.mockResolvedValue(server({ id: 'existing-1', name: 'Pleo', status: 'enabled', delegation: 'service', discoveredTools: [{ name: 'list_missing_receipts' }] }));
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Manual' }));
    await userEvent.type(screen.getByTestId('mcp-add-manual-name'), 'Pleo');
    await userEvent.type(screen.getByTestId('mcp-add-manual-endpoint'), 'https://mcp.pleo.io');
    await userEvent.click(screen.getByRole('button', { name: 'Create server' }));
    expect(await screen.findByTestId('mcp-add-use-existing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use the existing server' }));
    expect(mockDiscoverTools).toHaveBeenCalledWith('existing-1');
    expect(await screen.findAllByTestId('mcp-add-tool')).toHaveLength(1);
  });
});

describe('McpAddServerModal — authorized but still refused', () => {
  it('tells the operator the endpoint path is the likely culprit when auth-status is connected yet discovery says needs-auth', async () => {
    mockListRegistries.mockResolvedValue({ registries: [] });
    mockCreateServer.mockResolvedValue(server({ status: 'enabled', endpoint: 'https://mcp.pleo.io' }));
    mockDiscoverTools.mockRejectedValue(new ApiError(409, 'POST failed: 409', JSON.stringify({ error: 'mcp_needs_auth', serverId: 's1', message: 'Version negotiation failed: the server denied access (HTTP 403)' })));
    mockGetAuthStatus.mockResolvedValue({ protected: true, connected: true } as never);
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Manual' }));
    await userEvent.type(screen.getByTestId('mcp-add-manual-name'), 'Pleo');
    await userEvent.type(screen.getByTestId('mcp-add-manual-endpoint'), 'https://mcp.pleo.io');
    await userEvent.click(screen.getByRole('button', { name: 'Create server' }));
    expect(await screen.findByTestId('mcp-add-authorized-refused')).toHaveTextContent(/\/mcp/);
  });
});

describe('McpAddServerModal — change tool on a connected server', () => {
  it('with initialServerId skips Find and goes straight to discovery of that server', async () => {
    mockListServers.mockResolvedValue({ servers: [DISCOVERED_SERVER] });
    mockDiscoverTools.mockResolvedValue(DISCOVERED_SERVER);
    const onResolve = vi.fn();
    renderWithIntl(<McpAddServerModal initialServerId="s1" missingRef="pleo.list_missing_receipts" onResolve={onResolve} onClose={vi.fn()} />);
    expect(await screen.findAllByTestId('mcp-add-tool')).toHaveLength(2);
    expect(mockDiscoverTools).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('tab', { name: 'Manual' })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByTestId('mcp-add-tool')[0] as HTMLElement);
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ serverId: 's1' }));
  });
});

describe('McpAddServerModal — connected servers tab', () => {
  it('lists existing servers as the default tab and continues with the picked one', async () => {
    mockListServers.mockResolvedValue({ servers: [DISCOVERED_SERVER] });
    mockListRegistries.mockResolvedValue({ registries: [] });
    mockDiscoverTools.mockResolvedValue(DISCOVERED_SERVER);
    renderWithIntl(<McpAddServerModal onResolve={vi.fn()} onClose={vi.fn()} />);
    const row = await screen.findByTestId('mcp-add-existing-server');
    expect(row).toHaveAttribute('data-server-id', 's1');
    expect(screen.getByRole('tab', { name: 'Connected (1)' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(row);
    expect(mockDiscoverTools).toHaveBeenCalledWith('s1');
    expect(await screen.findAllByTestId('mcp-add-tool')).toHaveLength(2);
  });
});
