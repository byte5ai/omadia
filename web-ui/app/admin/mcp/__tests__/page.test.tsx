import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { McpServerNode } from '../../../_lib/agentBuilder';
import AdminMcpPage from '../page';

/**
 * Issue #541 — MCP 2026-07-28 deprecates the legacy HTTP+SSE transport.
 *
 * The operator picker must therefore not offer `sse` by default (http /
 * Streamable HTTP stays the default), but must NOT hard-block it either: the
 * removal window is at least 12 months, so re-creating a legacy SSE server has
 * to stay possible behind the "show deprecated transports" toggle. Existing sse
 * rows keep working and are badged rather than hidden.
 */

const { mockListMcpServers } = vi.hoisted(() => ({ mockListMcpServers: vi.fn() }));

// Spread the real module so DEPRECATED_MCP_TRANSPORTS (the shared source of
// truth this UI derives from) stays genuine; only the network call is stubbed.
vi.mock('../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentBuilder')>()),
  listMcpServers: mockListMcpServers,
}));

function server(overrides: Partial<McpServerNode>): McpServerNode {
  return {
    id: 'srv-1',
    name: 'srv',
    transport: 'http',
    endpoint: 'https://x.example/mcp',
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    ...overrides,
  } as McpServerNode;
}

const LEGACY = server({
  id: 'srv-sse',
  name: 'legacy-sse',
  transport: 'sse',
  transportDeprecated: true,
  endpoint: 'https://legacy.example/sse',
});
const MODERN = server({
  id: 'srv-http',
  name: 'modern-http',
  transport: 'http',
  transportDeprecated: false,
});

beforeEach(() => {
  mockListMcpServers.mockReset();
  mockListMcpServers.mockResolvedValue({ servers: [LEGACY, MODERN] });
});

async function renderServersPane(): Promise<HTMLSelectElement> {
  renderWithIntl(<AdminMcpPage />);
  await waitFor(() => expect(mockListMcpServers).toHaveBeenCalled());
  return (await screen.findByLabelText('Transport')) as HTMLSelectElement;
}

function optionValues(select: HTMLSelectElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value);
}

describe('MCP admin transport picker (#541)', () => {
  it('hides the deprecated sse transport by default and defaults to http', async () => {
    const select = await renderServersPane();
    expect(optionValues(select)).toEqual(['http', 'stdio']);
    expect(select.value).toBe('http');
  });

  it('offers sse once deprecated transports are shown — never hard-blocked', async () => {
    const user = userEvent.setup();
    const select = await renderServersPane();

    await user.click(screen.getByLabelText('Show deprecated transports'));

    expect(optionValues(select)).toEqual(['http', 'stdio', 'sse']);
    // Labelled so the operator cannot pick it unaware of the deprecation.
    expect(within(select).getByRole('option', { name: 'sse (deprecated)' })).toBeTruthy();

    // …and it is genuinely selectable: an operator must still be able to
    // register a legacy SSE server during the removal window.
    await user.selectOptions(select, 'sse');
    expect(select.value).toBe('sse');
  });

  it('resets a selected sse back to http when the toggle is switched off again', async () => {
    const user = userEvent.setup();
    const select = await renderServersPane();
    const toggle = screen.getByLabelText('Show deprecated transports');

    await user.click(toggle);
    await user.selectOptions(select, 'sse');
    await user.click(toggle);

    expect(optionValues(select)).toEqual(['http', 'stdio']);
    expect(select.value).toBe('http');
  });

  it('badges an existing sse row as deprecated and leaves http rows unbadged', async () => {
    await renderServersPane();

    const sseRow = (await screen.findByText('legacy-sse')).closest('tr');
    const httpRow = (await screen.findByText('modern-http')).closest('tr');
    expect(sseRow).toBeTruthy();
    expect(httpRow).toBeTruthy();

    expect(within(sseRow as HTMLElement).getByText('Deprecated')).toBeTruthy();
    expect(within(httpRow as HTMLElement).queryByText('Deprecated')).toBeNull();
  });

  it('falls back to the local deprecation list when the middleware omits the flag', async () => {
    // An older middleware build does not send `transportDeprecated`; the badge
    // must still appear so operators are not silently left in the dark.
    mockListMcpServers.mockResolvedValue({
      servers: [server({ id: 'old', name: 'old-sse', transport: 'sse' })],
    });
    await renderServersPane();
    const row = (await screen.findByText('old-sse')).closest('tr');
    expect(within(row as HTMLElement).getByText('Deprecated')).toBeTruthy();
  });
});
