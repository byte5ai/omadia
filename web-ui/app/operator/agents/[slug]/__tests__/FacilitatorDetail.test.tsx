import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { OperatorAgentDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentDetail } from '../_components/AgentDetail';

/**
 * #2066 — the page of one facilitator.
 *
 *   1. WHAT IT MUST NOT HAVE HAS NO TAB: plugins, tools/MCP, conversations
 *      with other agents, memory. One line says why. None of their read
 *      models are fetched.
 *   2. IDENTITY RUNS IN FACILITATOR MODE, Teams provisioning is reused.
 *   3. THE ENGINE IS THE ONE GRANT: granted with a replace-set of exactly
 *      that plugin; a refusal is shown as its catalogue sentence.
 *   4. A STANDARD AGENT KEEPS EVERY TAB and gets no engine tab.
 */

const { mockCatalog, mockReplace, mockTeams, mockEngine, mockRefresh, identityProps } =
  vi.hoisted(() => ({
    mockCatalog: vi.fn(),
    mockReplace: vi.fn(),
    mockTeams: vi.fn(),
    mockEngine: vi.fn(),
    mockRefresh: vi.fn(),
    identityProps: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listAgentPluginCatalog: mockCatalog,
  replaceAgentPlugins: mockReplace,
  getAgentTeamsIdentity: mockTeams,
}));

vi.mock('../../../../_lib/facilitators', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/facilitators')>()),
  loadFacilitationEngineStatus: mockEngine,
}));

vi.mock('../_components/AgentIdentity', () => ({
  AgentIdentity: (props: { slug: string; kind?: string }) => {
    identityProps(props);
    return <div data-testid="agent-identity" />;
  },
}));
vi.mock('../_components/AgentTeamsIdentity', () => ({
  AgentTeamsIdentity: () => <div data-testid="agent-teams-identity" />,
}));
vi.mock('../_components/AgentTeamsInstalls', () => ({
  AgentTeamsInstalls: () => <div data-testid="agent-teams-installs" />,
}));
vi.mock('../_components/AgentModelPolicy', () => ({
  AgentModelPolicy: () => <div data-testid="agent-model-policy" />,
}));
vi.mock('../_components/AgentPeers', () => ({
  AgentPeers: () => <div data-testid="agent-peers" />,
}));
vi.mock('../_components/AgentToolGrants', () => ({
  AgentToolGrants: () => <div data-testid="agent-tool-grants" />,
}));
vi.mock('../_components/AgentMcpServers', () => ({
  AgentMcpServers: () => <div data-testid="agent-mcp-servers" />,
}));
vi.mock('../_components/AgentContextMemory', () => ({
  AgentContextMemory: () => <div data-testid="agent-context-memory" />,
}));
vi.mock('../../_components/PluginsDnd', () => ({
  PluginsDnd: () => <div data-testid="plugins-dnd" />,
}));

const ENGINE = { id: '@omadia/agent-facilitator', name: 'Facilitation Engine' };

function agent(over: Partial<OperatorAgentDto> = {}): OperatorAgentDto {
  return {
    id: 'id-mona',
    slug: 'mona',
    name: 'Mona',
    description: null,
    privacy_profile: 'default',
    status: 'enabled',
    kind: 'facilitator',
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
    active: true,
    memory_scope: [],
    plugins: [],
    bindings: [],
    ...over,
  };
}

function tabIds(): string[] {
  return screen.getAllByRole('tab').map((el) => el.getAttribute('data-testid') ?? '');
}

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('AgentDetail — facilitator (#2066)', () => {
  it('offers only the tabs a facilitator has and says why', async () => {
    mockEngine.mockResolvedValue({ state: 'ready', plugin: ENGINE });
    mockTeams.mockResolvedValue({ state: 'installed' });
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    expect(tabIds()).toEqual([
      'agent-detail-tab-identity',
      'agent-detail-tab-model',
      'agent-detail-tab-teams',
      'agent-detail-tab-engine',
    ]);
    expect(screen.getByTestId('facilitator-omitted-note').textContent).toContain(
      'No plugins, tools, MCP servers, memory',
    );
    expect(identityProps).toHaveBeenCalledWith({ slug: 'mona', kind: 'facilitator' });
    // The plugin catalogue is the standard page's read model — not fetched.
    expect(mockCatalog).not.toHaveBeenCalled();
    await waitFor(() => expect(mockTeams).toHaveBeenCalledWith('mona'));
  });

  it('lands on the first tab for a deep link to a tab it does not have', async () => {
    window.history.replaceState(null, '', '/?tab=plugins');
    mockEngine.mockResolvedValue({ state: 'none' });
    mockTeams.mockResolvedValue({ state: 'installed' });
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);
    expect(screen.getByTestId('agent-identity')).toBeTruthy();
    expect(screen.queryByTestId('plugins-dnd')).toBeNull();
    await screen.findByTestId('facilitation-engine-notice');
  });

  it('reuses Teams provisioning on the Teams tab', async () => {
    mockEngine.mockResolvedValue({ state: 'ready', plugin: ENGINE });
    mockTeams.mockRejectedValue(
      new ApiError(404, 'x', JSON.stringify({ error: 'teams_identity_not_found' })),
    );
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);
    await screen.findByTestId('facilitator-readiness-teams');
    await userEvent.click(screen.getByTestId('agent-detail-tab-teams'));
    expect(screen.getByTestId('agent-teams-identity')).toBeTruthy();
    expect(screen.getByTestId('agent-teams-installs')).toBeTruthy();
  });

  it('grants the engine as the only plugin', async () => {
    mockEngine.mockResolvedValue({ state: 'ready', plugin: ENGINE });
    mockTeams.mockResolvedValue({ state: 'installed' });
    mockReplace.mockResolvedValue(undefined);
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);
    await userEvent.click(screen.getByTestId('agent-detail-tab-engine'));
    await userEvent.click(await screen.findByTestId('facilitator-engine-grant'));
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('mona', [{ id: ENGINE.id, enabled: true }]),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('shows the engine as granted when its row is enabled', async () => {
    mockEngine.mockResolvedValue({ state: 'ready', plugin: ENGINE });
    mockTeams.mockResolvedValue({ state: 'installed' });
    renderWithIntl(
      <AgentDetail
        agent={agent({ plugins: [{ id: ENGINE.id, enabled: true, config: {} }] })}
        isFallback={false}
      />,
    );
    await userEvent.click(screen.getByTestId('agent-detail-tab-engine'));
    expect(await screen.findByTestId('facilitator-engine-granted')).toBeTruthy();
    expect(screen.queryByTestId('facilitator-engine-grant')).toBeNull();
  });

  it('shows a refused grant as its catalogue sentence', async () => {
    mockEngine.mockResolvedValue({ state: 'ready', plugin: ENGINE });
    mockTeams.mockResolvedValue({ state: 'installed' });
    mockReplace.mockRejectedValue(
      new ApiError(
        409,
        'PUT failed: 409',
        JSON.stringify({
          error: 'facilitator_omission',
          omission: 'plugin_grant',
          message: 'server prose',
          refused_plugins: [ENGINE.id],
        }),
      ),
    );
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);
    await userEvent.click(screen.getByTestId('agent-detail-tab-engine'));
    await userEvent.click(await screen.findByTestId('facilitator-engine-grant'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('only gets the tools of the facilitation engine');
    expect(alert.textContent).toContain(ENGINE.id);
    expect(alert.textContent).not.toContain('server prose');
  });

  it('keeps every tab for a standard agent and adds no engine tab', async () => {
    mockCatalog.mockResolvedValue({ items: [] });
    renderWithIntl(
      <AgentDetail agent={agent({ slug: 'sales', kind: 'standard' })} isFallback={false} />,
    );
    expect(tabIds()).toEqual([
      'agent-detail-tab-identity',
      'agent-detail-tab-model',
      'agent-detail-tab-peers',
      'agent-detail-tab-teams',
      'agent-detail-tab-plugins',
      'agent-detail-tab-tools',
      'agent-detail-tab-memory',
    ]);
    expect(screen.queryByTestId('facilitator-detail')).toBeNull();
    await waitFor(() => expect(mockCatalog).toHaveBeenCalled());
    expect(mockEngine).not.toHaveBeenCalled();
  });
});
