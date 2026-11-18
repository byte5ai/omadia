import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type {
  OperatorAgentDto,
  OperatorAgentsListDto,
} from '../../../../_lib/agents';
import type { FacilitationEngineStatus } from '../../../../_lib/facilitators';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentsDashboard } from '../AgentsDashboard';

/**
 * #2066 — "Facilitators" next to "Orchestrators" in the agent directory.
 *
 *   1. LISTED BY KIND. A facilitator is not an orchestrator: it is not in
 *      that list, not in its count and cannot be picked as the standard
 *      orchestrator.
 *   2. CREATE sends `kind: 'facilitator'` and continues on the new page.
 *   3. NOT READY WITHOUT ITS OWN TEAMS IDENTITY, with a link to provisioning.
 *   4. THE ENGINE NOTICE says what is missing — no engine, or no SQL grant.
 *   5. A 409 `facilitator_omission` is a sentence, not a machine code.
 */

const {
  mockCreate,
  mockPatch,
  mockSetFallback,
  mockTeams,
  mockEngine,
  mockPush,
  mockRefresh,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockPatch: vi.fn(),
  mockSetFallback: vi.fn(),
  mockTeams: vi.fn(),
  mockEngine: vi.fn(),
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listAgentPluginCatalog: vi.fn().mockResolvedValue({ items: [] }),
  createOperatorAgent: mockCreate,
  patchOperatorAgent: mockPatch,
  setFallbackAgent: mockSetFallback,
  getAgentTeamsIdentity: mockTeams,
}));

vi.mock('../../../../_lib/facilitators', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/facilitators')>()),
  loadFacilitationEngineStatus: mockEngine,
}));

vi.mock('../PluginsDnd', () => ({
  PluginsDnd: () => <div data-testid="plugins-dnd" />,
}));

function agent(over: Partial<OperatorAgentDto>): OperatorAgentDto {
  return {
    id: `id-${over.slug ?? 'x'}`,
    slug: 'x',
    name: 'X',
    description: null,
    privacy_profile: 'default',
    status: 'enabled',
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
    active: true,
    memory_scope: [],
    plugins: [],
    bindings: [],
    ...over,
  };
}

const ENGINE = { id: '@omadia/agent-facilitator', name: 'Facilitation Engine' };
const READY: FacilitationEngineStatus = { state: 'ready', pluginId: ENGINE.id };

function list(...agents: OperatorAgentDto[]): OperatorAgentsListDto {
  return { agents, fallback_agent_id: 'id-fallback' };
}

const FALLBACK = agent({ slug: 'fallback', name: 'Standard' });
const SALES = agent({ slug: 'sales', name: 'Sales' });
const MONA = agent({ slug: 'mona', name: 'Mona', kind: 'facilitator' });

function teamsMissing(): ApiError {
  return new ApiError(404, 'GET failed: 404', JSON.stringify({ error: 'teams_identity_not_found' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentsDashboard — facilitators (#2066)', () => {
  it('lists facilitators apart from orchestrators', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, SALES, MONA)} />);

    const section = screen.getByTestId('facilitators-section');
    expect(section.textContent).toContain('Facilitators (1)');
    expect(screen.getByTestId('facilitator-card-mona')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Orchestrators \(2\)/ })).toBeTruthy();

    // Not offered as the standard orchestrator.
    const picker = screen.getByRole('combobox', { name: /Standard orchestrator/ });
    const options = [...(picker as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toContain('sales');
    expect(options).not.toContain('mona');

    // The card says why it has no plugin editor.
    expect(screen.getByTestId('facilitator-card-mona').textContent).toContain(
      'would make a moderator partial',
    );
    await waitFor(() => expect(mockTeams).toHaveBeenCalledWith('mona'));
  });

  it('shows a facilitator without its own Teams identity as not ready', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);

    const teams = await screen.findByTestId('facilitator-readiness-teams');
    expect(screen.getByTestId('facilitator-readiness').getAttribute('data-ready')).toBe('false');
    expect(teams.textContent).toContain('No Teams identity of its own yet');
    expect(teams.querySelector('a')?.getAttribute('href')).toBe(
      '/operator/agents/mona?tab=teams',
    );
  });

  it('is ready with an installed identity and the granted engine', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockResolvedValue({ state: 'installed' });
    const granted = agent({
      slug: 'mona',
      name: 'Mona',
      kind: 'facilitator',
      plugins: [{ id: ENGINE.id, enabled: true, config: {} }],
    });
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, granted)} />);
    await waitFor(() =>
      expect(screen.getByTestId('facilitator-readiness').getAttribute('data-ready')).toBe('true'),
    );
    expect(screen.queryByTestId('facilitation-engine-notice')).toBeNull();
  });

  it('asks for the engine grant when the engine runs but is not granted', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockResolvedValue({ state: 'installed' });
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);
    const grant = await screen.findByTestId('facilitator-readiness-grant');
    expect(grant.querySelector('a')?.getAttribute('href')).toBe(
      '/operator/agents/mona?tab=engine',
    );
  });

  it('says that no facilitation engine is installed', async () => {
    mockEngine.mockResolvedValue({ state: 'none' });
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);
    const notice = await screen.findByTestId('facilitation-engine-notice');
    expect(notice.textContent).toContain('No facilitation engine is installed');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/store');
  });

  it('says that the installed engine is not usable and links to its grants', async () => {
    mockEngine.mockResolvedValue({
      state: 'unavailable',
      pluginId: ENGINE.id,
      reason: 'The operator has not granted SQL access.',
    });
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);
    const notice = await screen.findByTestId('facilitation-engine-notice');
    expect(notice.textContent).toContain('cannot run facilitations yet');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe(
      `/store/${encodeURIComponent(ENGINE.id)}#grants`,
    );
    // The engine's own sentence is detail behind the catalogue text.
    expect(screen.getByTestId('facilitation-engine-reason').textContent).toBe(
      'The engine reports: The operator has not granted SQL access.',
    );
    expect(screen.getByTestId('facilitator-readiness-engine')).toBeTruthy();
  });

  it('names the engines when more than one is installed', async () => {
    mockEngine.mockResolvedValue({ state: 'ambiguous', pluginIds: ['a.engine', 'b.engine'] });
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);
    const notice = await screen.findByTestId('facilitation-engine-notice');
    expect(notice.textContent).toContain('a.engine, b.engine');
  });

  it('links to the facilitations view of a usable engine that has a nav entry', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(
      <AgentsDashboard
        initial={list(FALLBACK, MONA)}
        pluginNav={[
          { pluginId: 'other', href: '/plugin-ui/other', label: 'Other' },
          { pluginId: ENGINE.id, href: '/plugin-ui/engine', label: 'Facilitations' },
        ]}
      />,
    );
    const link = await screen.findByTestId('facilitations-view-link');
    expect(link.getAttribute('href')).toBe('/plugin-ui/engine');
    expect(link.textContent).toContain('Facilitations');
  });

  it('offers no facilitations link while the engine is not usable', async () => {
    mockEngine.mockResolvedValue({ state: 'unavailable', pluginId: ENGINE.id, reason: null });
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(
      <AgentsDashboard
        initial={list(FALLBACK, MONA)}
        pluginNav={[{ pluginId: ENGINE.id, href: '/plugin-ui/engine', label: 'Facilitations' }]}
      />,
    );
    await screen.findByTestId('facilitation-engine-notice');
    expect(screen.queryByTestId('facilitations-view-link')).toBeNull();
  });

  it('does not claim "no engine" when the status cannot be read', async () => {
    mockEngine.mockRejectedValue(new Error('store down'));
    mockTeams.mockRejectedValue(teamsMissing());
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, MONA)} />);
    const notice = await screen.findByTestId('facilitation-engine-notice');
    expect(notice.textContent).toContain('could not be checked');
    expect(notice.textContent).not.toContain('store down');
  });

  it('creates with kind facilitator and opens the new page', async () => {
    mockEngine.mockResolvedValue(READY);
    mockCreate.mockResolvedValue({ id: 'id-rita', slug: 'rita', kind: 'facilitator' });
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK)} />);

    await userEvent.type(screen.getByTestId('facilitator-create-slug'), 'rita');
    await userEvent.type(screen.getByTestId('facilitator-create-name'), 'Rita');
    await userEvent.click(screen.getByRole('button', { name: 'Create facilitator' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        slug: 'rita',
        name: 'Rita',
        kind: 'facilitator',
      }),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/operator/agents/rita'));
  });

  it('prints the omission sentence for a 409 facilitator_omission', async () => {
    mockEngine.mockResolvedValue(READY);
    mockTeams.mockRejectedValue(teamsMissing());
    mockSetFallback.mockRejectedValue(
      new ApiError(
        409,
        'PUT failed: 409',
        JSON.stringify({
          error: 'facilitator_omission',
          omission: 'default_agent',
          message: 'agent "mona" is a facilitator: server prose',
        }),
      ),
    );
    renderWithIntl(<AgentsDashboard initial={list(FALLBACK, SALES, MONA)} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Standard orchestrator/ }),
      'sales',
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'A facilitator cannot be the standard orchestrator',
      ),
    );
    expect(document.body.textContent).not.toContain('server prose');
    expect(document.body.textContent).not.toContain('facilitator_omission');
  });
});
