import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { GrantToAgentsStep } from '../GrantToAgentsStep';

/**
 * #2054 — spec 2042 §5.2 / INV-8: installing a capability plugin grants it to
 * no agent; the install flow offers it to the agents the operator picks,
 * none preselected. Other plugin kinds are never offered.
 */

const { mockCatalog, mockAgents, mockToggle, mockRefresh } = vi.hoisted(() => ({
  mockCatalog: vi.fn(),
  mockAgents: vi.fn(),
  mockToggle: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock('../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agents')>()),
  listAgentPluginCatalog: mockCatalog,
  listOperatorAgents: mockAgents,
  toggleAgentPlugin: mockToggle,
}));

function entry(id: string, name: string, kind: string, capability: boolean, depends_on: string[] = []) {
  return {
    id,
    name,
    kind,
    version: '1.0.0',
    multi_instance: true,
    privacy_class: 'default',
    memory_reads: [],
    memory_writes: [],
    network_outbound: [],
    setup_fields: [],
    depends_on,
    capability,
  };
}

function agentDto(slug: string, name: string, plugins: Array<{ id: string; enabled: boolean }> = []) {
  return {
    id: `id-${slug}`,
    slug,
    name,
    description: null,
    privacy_profile: 'default',
    status: 'enabled',
    archetype: 'standard',
    created_at: '',
    updated_at: '',
    active: true,
    memory_scope: [],
    plugins: plugins.map((p) => ({ ...p, config: {} })),
    bindings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCatalog.mockResolvedValue({
    items: [
      entry('@acme/odoo', 'Odoo', 'integration', true),
      entry('@acme/accounting', 'Accounting', 'agent', true, ['@acme/odoo']),
      entry('@acme/teams', 'Teams', 'channel', false),
    ],
  });
  mockAgents.mockResolvedValue({
    agents: [
      agentDto('sales', 'Sales'),
      agentDto('finance', 'Finance', [{ id: '@acme/accounting', enabled: true }]),
      { ...agentDto('mara', 'Mara'), archetype: 'facilitator' },
    ],
    fallback_agent_id: null,
  });
  mockToggle.mockResolvedValue({ ok: true, fallback: false, plugin: { id: 'x', enabled: true } });
});

describe('GrantToAgentsStep (#2054)', () => {
  it('offers a capability plugin to standard agents, none preselected, and grants it with its parent', async () => {
    const user = userEvent.setup();
    renderWithIntl(<GrantToAgentsStep pluginIds={['@acme/accounting']} />);

    const sales = await screen.findByRole('checkbox', { name: 'Sales' });
    expect((sales as HTMLInputElement).checked).toBe(false);
    // Already holds it: shown, not selectable.
    const finance = screen.getByRole('checkbox', { name: /Finance/ });
    expect((finance as HTMLInputElement).disabled).toBe(true);
    // A facilitator holds no business capabilities: not offered.
    expect(screen.queryByText('Mara')).toBeNull();
    expect(mockToggle).not.toHaveBeenCalled();

    await user.click(sales);
    await user.click(screen.getByRole('button', { name: 'Grant to selected agents' }));

    await waitFor(() => expect(mockToggle).toHaveBeenCalledTimes(2));
    expect(mockToggle.mock.calls).toEqual([
      ['sales', '@acme/odoo', true, { confirmBroadReach: false }],
      ['sales', '@acme/accounting', true, { confirmBroadReach: false }],
    ]);
    expect(await screen.findByText('Granted to Sales.')).toBeTruthy();
  });

  it('never offers a plugin that is not a capability plugin', async () => {
    renderWithIntl(<GrantToAgentsStep pluginIds={['@acme/teams']} />);
    await waitFor(() => expect(mockAgents).toHaveBeenCalled());
    expect(screen.queryByTestId('grant-to-agents')).toBeNull();
  });

  it('says why it cannot offer the plugin instead of hiding (#1880); only a missing runtime hides it', async () => {
    mockAgents.mockRejectedValueOnce(new ApiError(500, 'GET failed: 500', JSON.stringify({ error: 'internal' })));
    const { unmount } = renderWithIntl(<GrantToAgentsStep pluginIds={['@acme/odoo']} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
    unmount();

    mockAgents.mockRejectedValueOnce(new ApiError(503, 'GET failed: 503', JSON.stringify({ error: 'multi_orchestrator_unavailable' })));
    renderWithIntl(<GrantToAgentsStep pluginIds={['@acme/odoo']} />);
    await waitFor(() => expect(mockAgents).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('grant-to-agents')).toBeNull();
  });
});
