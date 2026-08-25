import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type { AgentGrantsDto } from '../../../../_lib/agents';
import { AgentToolGrants } from '../_components/AgentToolGrants';

/**
 * Issue #861 (epic #860) — per-agent tool-grant list with grant-epoch
 * display.
 *
 * The component consumes the per-agent read model
 * (`GET /v1/operator/agents/:slug/grants`): `agent_tool_grants` rows plus
 * the `plugin_mcp_grants` of every plugin assigned to the agent. The grant
 * epoch is `config.verdictEpoch` (a `now()::text` timestamp stamped by
 * `bumpMcpGrantEpoch`), so `null` is a legitimate "never bumped" state and
 * must render as such rather than as missing data.
 */

const { mockGetAgentGrants } = vi.hoisted(() => ({
  mockGetAgentGrants: vi.fn(),
}));

// Spread the real module so the error-code parser (the shared contract this
// UI maps to catalogue keys) stays genuine; only the network call is stubbed.
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentGrants: mockGetAgentGrants,
}));

function grantsDto(overrides: Partial<AgentGrantsDto> = {}): AgentGrantsDto {
  return {
    slug: 'sales-bot',
    grant_epoch: '2026-08-01 10:00:00.123456+00',
    tool_grants: [
      {
        id: 'grant-1',
        tool_kind: 'mcp',
        tool_ref: 'odoo.search_partners',
        sub_agent_id: null,
        mcp_server_id: 'srv-odoo',
        server_name: 'odoo-mcp',
        grant_epoch: '2026-08-01 10:00:00.123456+00',
        created_at: '2026-07-30T08:00:00.000Z',
      },
      {
        id: 'grant-2',
        tool_kind: 'native',
        tool_ref: 'memory.search',
        sub_agent_id: null,
        mcp_server_id: null,
        server_name: null,
        grant_epoch: null,
        created_at: '2026-07-30T08:00:00.000Z',
      },
    ],
    plugin_mcp_grants: [
      {
        plugin_id: '@omadia/odoo',
        mcp_server_id: 'srv-odoo',
        server_name: 'odoo-mcp',
        granted_by: 'operator',
        granted_at: '2026-07-31 09:30:00+00',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetAgentGrants.mockReset();
  mockGetAgentGrants.mockResolvedValue(grantsDto());
});

async function renderGrants(): Promise<void> {
  renderWithIntl(<AgentToolGrants slug="sales-bot" />);
  await waitFor(() => expect(mockGetAgentGrants).toHaveBeenCalledWith('sales-bot'));
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('li');
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

describe('AgentToolGrants (#861)', () => {
  it('lists the agent tool grants with kind, server, and a formatted grant epoch', async () => {
    await renderGrants();

    const mcpRow = rowOf('odoo.search_partners');
    expect(within(mcpRow).getByText('MCP')).toBeTruthy();
    expect(within(mcpRow).getByText('odoo-mcp')).toBeTruthy();
    // The Postgres `now()::text` epoch is formatted for humans (raw value
    // kept as the tooltip), so the row shows a localized date, not the
    // verbatim "+00" string.
    expect(within(mcpRow).getByText(/epoch: .*2026/)).toBeTruthy();
    expect(within(mcpRow).queryByText(/\+00/)).toBeNull();
    expect(
      within(mcpRow).getByTitle('2026-08-01 10:00:00.123456+00'),
    ).toBeTruthy();
  });

  it('renders a null grant epoch as its own "never bumped" state', async () => {
    await renderGrants();

    const nativeRow = rowOf('memory.search');
    expect(within(nativeRow).getByText(/never bumped/)).toBeTruthy();
    // Native grants have no MCP server to attribute.
    expect(within(nativeRow).queryByText('odoo-mcp')).toBeNull();
  });

  it('shows the latest grant epoch in the heading summary, and "never bumped" when no grant was ever bumped', async () => {
    await renderGrants();
    expect(screen.getByText(/Grant epoch: .*2026/)).toBeTruthy();

    mockGetAgentGrants.mockResolvedValue(
      grantsDto({ grant_epoch: null, tool_grants: [], plugin_mcp_grants: [] }),
    );
    renderWithIntl(<AgentToolGrants slug="fresh-bot" />);
    expect(await screen.findByText('Grant epoch: never bumped')).toBeTruthy();
  });

  it('lists plugin MCP grants with server and attribution', async () => {
    await renderGrants();

    const pluginRow = rowOf('@omadia/odoo');
    expect(within(pluginRow).getByText('odoo-mcp')).toBeTruthy();
    expect(within(pluginRow).getByText(/granted by operator/)).toBeTruthy();
  });

  it('renders both empty states when the agent holds nothing', async () => {
    mockGetAgentGrants.mockResolvedValue(
      grantsDto({ grant_epoch: null, tool_grants: [], plugin_mcp_grants: [] }),
    );
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);

    expect(
      await screen.findByText('This orchestrator holds no tool grants yet.'),
    ).toBeTruthy();
    expect(
      screen.getByText("No MCP servers are granted to this orchestrator's plugins."),
    ).toBeTruthy();
  });

  it('maps machine error codes to localized copy — the raw body never renders', async () => {
    mockGetAgentGrants.mockRejectedValue(
      new ApiError(404, 'GET /v1/operator/agents/sales-bot/grants failed: 404', '{"error":"not_found"}'),
    );
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'This orchestrator does not exist anymore — reload the page.',
    );
    expect(alert.textContent).not.toContain('not_found');
  });

  it('falls back to the localized unknown-error sentence with the technical detail', async () => {
    mockGetAgentGrants.mockRejectedValue(new Error('socket hang up'));
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Loading grants failed:');
    expect(alert.textContent).toContain('socket hang up');
  });

  it('re-fetches on Refresh and recovers from a failed load', async () => {
    mockGetAgentGrants.mockRejectedValueOnce(new Error('offline'));
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);
    await screen.findByRole('alert');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('odoo.search_partners')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockGetAgentGrants).toHaveBeenCalledTimes(2);
  });

  it('reports the epoch as UNKNOWN, not "never bumped", while the load is pending', async () => {
    // "Never bumped" is a factual claim about authorization state. While the
    // DTO has not resolved, the truth is unknown — asserting "never bumped"
    // during the pending window would be a false statement (W0c review).
    let resolve!: (v: unknown) => void;
    mockGetAgentGrants.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);

    expect(screen.getByText('Grant epoch: unknown')).toBeTruthy();
    expect(screen.queryByText('Grant epoch: never bumped')).toBeNull();

    resolve(grantsDto({ grant_epoch: null, tool_grants: [], plugin_mcp_grants: [] }));
    expect(await screen.findByText('Grant epoch: never bumped')).toBeTruthy();
    expect(screen.queryByText('Grant epoch: unknown')).toBeNull();
  });

  it('reports the epoch as UNKNOWN after a failed load — never a false "never bumped"', async () => {
    mockGetAgentGrants.mockRejectedValue(new Error('offline'));
    renderWithIntl(<AgentToolGrants slug="sales-bot" />);

    await screen.findByRole('alert');
    expect(screen.getByText('Grant epoch: unknown')).toBeTruthy();
    expect(screen.queryByText('Grant epoch: never bumped')).toBeNull();
  });
});
