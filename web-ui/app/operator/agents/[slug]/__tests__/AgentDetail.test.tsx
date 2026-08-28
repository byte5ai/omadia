import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type {
  OperatorAgentDto,
  PluginCatalogEntryDto,
} from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentDetail } from '../_components/AgentDetail';

/**
 * Issue #861 — agent detail route, plugin-assignment slice.
 *
 * What is worth guarding here is the wiring, not the pixels:
 *
 *  - one row per assigned plugin, checkbox mirroring `enabled`, catalog name
 *    joined in once the catalog resolves;
 *  - the instant toggle goes through `toggleAgentPlugin` (the single-plugin
 *    PATCH) with the INVERTED flag, and only a success refreshes the router;
 *  - a failed toggle renders the LOCALIZED message for the machine code —
 *    never the raw `{ error: ... }` body (web-ui i18n hard rule);
 *  - PluginsDnd saves are forwarded to `replaceAgentPlugins` for this
 *    agent's slug.
 *
 * PluginsDnd itself (dnd-kit drag) stays out of jsdom scope per the
 * vitest.config note — it is stubbed and driven via its onReplace callback.
 *
 * #914 removed the Agent-Builder link that Wave W2a added here, along with
 * the draft-matching heuristic behind it. What is guarded now is the opposite:
 * the identity section is mounted, and NOTHING on this page links to the
 * builder. The agent's identity belongs to the agent.
 */

const { mockCatalog, mockToggle, mockReplace, mockRefresh } = vi.hoisted(
  () => ({
    mockCatalog: vi.fn(),
    mockToggle: vi.fn(),
    mockReplace: vi.fn(),
    mockRefresh: vi.fn(),
  }),
);

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

// Spread the real module so parseOperatorAgentErrorCode (the code→copy
// narrowing under test) stays genuine; only the network calls are stubbed.
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listAgentPluginCatalog: mockCatalog,
  toggleAgentPlugin: mockToggle,
  replaceAgentPlugins: mockReplace,
}));

// W2a wiring: AgentDetail is the single composition point for the Teams
// sections, so both panels mount here. They fetch their own read models and
// render their own `role="alert"` banners on failure — which is THEIR
// contract, covered by AgentTeamsIdentity*.test.tsx and
// AgentTeamsInstalls.test.tsx. Stubbing them keeps this suite's alert
// assertions about AgentDetail's OWN write errors, exactly as the PluginsDnd
// stub below keeps the dnd editor out of scope.
vi.mock('../_components/AgentIdentity', () => ({
  AgentIdentity: () => <div data-testid="agent-identity" />,
}));

vi.mock('../_components/AgentTeamsIdentity', () => ({
  AgentTeamsIdentity: () => <div data-testid="agent-teams-identity" />,
}));

vi.mock('../_components/AgentTeamsInstalls', () => ({
  AgentTeamsInstalls: () => <div data-testid="agent-teams-installs" />,
}));

vi.mock('../../_components/PluginsDnd', async () => {
  const { useState } = await import('react');
  return {
    // The stub carries MOUNT-LOCAL state (like the real editor's unsaved
    // drafts) so the remount contract is testable: a remount resets
    // "dirty" back to "clean", a preserved mount keeps it.
    PluginsDnd: (props: {
      onReplace: (
        plugins: Array<{
          id: string;
          enabled?: boolean;
          config?: Record<string, unknown>;
        }>,
      ) => void;
    }) => {
      const [dirty, setDirty] = useState(false);
      return (
        <div>
          <span data-testid="plugins-dnd-state">{dirty ? 'dirty' : 'clean'}</span>
          {/* eslint-disable-next-line no-restricted-syntax -- test stub standing in for the dnd editor, not a §4.2 CTA */}
          <button
            type="button"
            data-testid="plugins-dnd-edit"
            onClick={() => setDirty(true)}
          />
          {/* eslint-disable-next-line no-restricted-syntax -- test stub standing in for the dnd editor, not a §4.2 CTA */}
          <button
            type="button"
            data-testid="plugins-dnd-save"
            onClick={() =>
              props.onReplace([{ id: '@omadia/odoo', enabled: true, config: {} }])
            }
          />
        </div>
      );
    },
  };
});

function agent(over: Partial<OperatorAgentDto> = {}): OperatorAgentDto {
  return {
    id: 'agent-1',
    slug: 'hr',
    name: 'HR',
    description: null,
    privacy_profile: 'default',
    status: 'enabled',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    active: true,
    memory_scope: [],
    plugins: [
      { id: '@omadia/confluence', config: {}, enabled: false },
      { id: '@omadia/odoo', config: {}, enabled: true },
    ],
    bindings: [],
    ...over,
  };
}

function catalogEntry(
  over: Partial<PluginCatalogEntryDto>,
): PluginCatalogEntryDto {
  return {
    id: '@omadia/odoo',
    name: 'Odoo',
    kind: 'integration',
    version: '1.0.0',
    multi_instance: false,
    privacy_class: 'default',
    memory_reads: [],
    memory_writes: [],
    network_outbound: [],
    setup_fields: [],
    depends_on: [],
    ...over,
  };
}

function draft(over: Partial<DraftSummary> = {}): DraftSummary {
  return {
    id: 'draft-1',
    name: 'HR persona',
    status: 'published',
    codegenModel: 'sonnet',
    previewModel: 'haiku',
    publishedAgentId: 'de.byte5.agent.hr',
    updatedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** An orchestrator whose assigned set contains a builder-published agent. */
function agentWithBuilderPlugin(): OperatorAgentDto {
  return agent({
    plugins: [{ id: 'de.byte5.agent.hr', config: {}, enabled: true }],
  });
}

const AGENT_KIND_CATALOG = {
  items: [
    catalogEntry({
      id: 'de.byte5.agent.hr',
      name: 'HR Agent',
      kind: 'agent',
    }),
  ],
};

beforeEach(() => {
  mockCatalog.mockReset();
  mockToggle.mockReset();
  mockReplace.mockReset();
  mockRefresh.mockReset();
  mockCatalog.mockResolvedValue({
    items: [
      catalogEntry({}),
      catalogEntry({ id: '@omadia/confluence', name: 'Confluence' }),
    ],
  });
  mockToggle.mockResolvedValue({
    ok: true,
    fallback: false,
    plugin: { id: '@omadia/odoo', enabled: false },
  });
  mockReplace.mockResolvedValue(undefined);
});

describe('AgentDetail plugin assignment', () => {
  it('renders one row per assigned plugin with its enabled state', async () => {
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    // Catalog names join in after the async catalog load.
    const odoo = await screen.findByRole('checkbox', {
      name: 'Enable or disable Odoo',
    });
    const confluence = screen.getByRole('checkbox', {
      name: 'Enable or disable Confluence',
    });
    expect(odoo).toBeChecked();
    expect(confluence).not.toBeChecked();
  });

  it('renders the empty state when the agent has no plugins assigned', async () => {
    renderWithIntl(
      <AgentDetail agent={agent({ plugins: [] })} isFallback={false} />,
    );
    expect(
      await screen.findByText(/No plugins are assigned to this orchestrator/),
    ).toBeInTheDocument();
  });

  it('toggling a row calls toggleAgentPlugin with the inverted flag and refreshes', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    const odoo = await screen.findByRole('checkbox', {
      name: 'Enable or disable Odoo',
    });
    await user.click(odoo);

    expect(mockToggle).toHaveBeenCalledWith('hr', '@omadia/odoo', false);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('maps a plugin_not_assigned failure to the localized message', async () => {
    mockToggle.mockRejectedValue(
      new ApiError(
        404,
        'PATCH /v1/operator/agents/hr/plugins failed: 404',
        JSON.stringify({ error: 'plugin_not_assigned' }),
      ),
    );
    const user = userEvent.setup();
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    await user.click(
      await screen.findByRole('checkbox', { name: 'Enable or disable Odoo' }),
    );

    expect(
      await screen.findByText(
        /This plugin is not assigned to the orchestrator anymore/,
      ),
    ).toBeInTheDocument();
    // The raw machine code must never surface as UI text.
    expect(screen.queryByText(/plugin_not_assigned/)).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows the store-config notice only for the fallback agent', async () => {
    const { unmount } = renderWithIntl(
      <AgentDetail agent={agent()} isFallback />,
    );
    expect(
      await screen.findByText(/always runs plugins with the global store config/),
    ).toBeInTheDocument();
    unmount();

    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);
    await screen.findByTestId('plugins-dnd-save');
    expect(
      screen.queryByText(/always runs plugins with the global store config/),
    ).toBeNull();
  });

  it('forwards PluginsDnd saves to replaceAgentPlugins for this slug', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    await user.click(await screen.findByTestId('plugins-dnd-save'));

    expect(mockReplace).toHaveBeenCalledWith('hr', [
      { id: '@omadia/odoo', enabled: true, config: {} },
    ]);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('a successful instant toggle does NOT remount the editor — unsaved edits survive', async () => {
    // Regression (W0c review): the toggle and the editor are two independent
    // write paths. When they shared one remount key, a successful toggle
    // remounted PluginsDnd and silently discarded every unsaved drag/config
    // edit below it. The stub's mount-local "dirty" flag stands in for that
    // unsaved state.
    const user = userEvent.setup();
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    await user.click(await screen.findByTestId('plugins-dnd-edit'));
    expect(screen.getByTestId('plugins-dnd-state').textContent).toBe('dirty');

    await user.click(
      await screen.findByRole('checkbox', { name: 'Enable or disable Odoo' }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());

    expect(screen.getByTestId('plugins-dnd-state').textContent).toBe('dirty');
  });

  it("the editor's own save DOES remount it so it reseeds from fresh props", async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    await user.click(await screen.findByTestId('plugins-dnd-edit'));
    expect(screen.getByTestId('plugins-dnd-state').textContent).toBe('dirty');

    await user.click(screen.getByTestId('plugins-dnd-save'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByTestId('plugins-dnd-state').textContent).toBe('clean'),
    );
  });
});

describe('AgentDetail identity section (#914)', () => {
  beforeEach(() => {
    mockCatalog.mockResolvedValue({ items: [] });
  });

  it('mounts the agent identity section', async () => {
    renderWithIntl(<AgentDetail agent={agent()} isFallback={false} />);

    expect(await screen.findByTestId('agent-identity')).toBeTruthy();
  });

  it('links nowhere near the Agent Builder', async () => {
    // The regression this issue exists to prevent. The old section in this
    // slot resolved a builder draft by heuristic and linked into
    // /store/builder — for most agents, into the builder OVERVIEW, which has
    // nothing to do with the agent in front of the operator.
    const { container } = renderWithIntl(
      <AgentDetail agent={agent()} isFallback={false} />,
    );
    await screen.findByTestId('agent-identity');

    expect(container.querySelectorAll('a[href*="builder"]').length).toBe(0);
    expect(screen.queryByText(/Agent Builder/)).toBeNull();
  });
});
