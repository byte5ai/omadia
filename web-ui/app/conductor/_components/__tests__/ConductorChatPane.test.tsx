import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conductorBuilderTurn,
  type ConductorBuilderTurnResult,
  type ConductorTemplate,
  type ConductorTemplateProposal,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { ConductorChatPane } from '../ConductorChatPane';

// Partial mock (#478 F4): only the turn call is stubbed — wire types and
// resolveConductorText stay real, so localization behaves as in production.
// The inline MCP connect modal has its own suite; here it is a stub that resolves a tool on click.
vi.mock('@/app/_components/mcp/McpAddServerModal', () => ({
  McpAddServerModal: ({ initialQuery, initialServerId, onResolve }: { initialQuery?: string; initialServerId?: string; onResolve: (r: { serverId: string; serverName: string; toolName: string; actionId: string }) => void }) => (
    <div data-testid="add-server-modal" data-query={initialQuery} data-initial-server={initialServerId ?? ''}>
      {/* eslint-disable-next-line no-restricted-syntax -- test stub standing in for the real modal's tool row */}
      <button type="button" onClick={() => onResolve({ serverId: 'srv-1', serverName: 'Pleo', toolName: 'list_missing_receipts', actionId: 'mcp:srv-1:list_missing_receipts' })}>
        pick-tool
      </button>
    </div>
  ),
}));

vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    conductorBuilderTurn: vi.fn(),
    publishConductorWorkflow: vi.fn(),
  };
});

const EMPTY_GRAPH = { entryStepId: '', steps: [], transitions: [], triggers: [] };

function turnResult(overrides: Partial<ConductorBuilderTurnResult> = {}): ConductorBuilderTurnResult {
  return {
    graph: EMPTY_GRAPH,
    patches: [],
    reply: 'Here is a first draft.',
    validation: { ok: true, errors: [] },
    applyErrors: [],
    ...overrides,
  };
}

const approvalTemplate: ConductorTemplate = {
  id: 'expense-approval',
  name: { en: 'Expense approval', de: 'Spesenfreigabe' },
  description: 'Route an expense to the right approver.',
  useCase: 'approval',
  defaultSlug: 'expense-approval',
  graph: { entryStepId: 'submit', steps: [], transitions: [], triggers: [] },
  slots: {
    roles: [
      { key: 'approver', label: 'Approver' },
      { key: 'finance', label: 'Finance escalation' },
    ],
    text: [{ key: 'policy', label: 'Policy note' }],
  },
};

const reportTemplate: ConductorTemplate = {
  id: 'weekly-report',
  name: 'Weekly report',
  description: 'Compile a status report every week.',
  useCase: 'reporting',
  defaultSlug: 'weekly-report',
  graph: { entryStepId: 'compile', steps: [], transitions: [], triggers: [] },
  slots: { agents: [{ key: 'reporter', label: 'Report writer' }] },
};

const approvalProposal: ConductorTemplateProposal = {
  templateId: 'expense-approval',
  version: 2,
  reason: 'Matches the approval flow you described.',
  // 1 of 3 declared slots prefilled; the undeclared key must NOT count.
  prefill: { roles: { approver: 'ops-lead', undeclared: 'x' } },
};

// The pane renders three textboxes (composer + slug + name) — target the
// composer via its placeholder.
async function sendMessage(): Promise<void> {
  await userEvent.type(screen.getByPlaceholderText(/When a PR is merged/), 'I need an approval flow');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('ConductorChatPane template proposals (#478 F4)', () => {
  it('renders proposal cards with name, version, reason and slot coverage', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult({ templateProposals: [approvalProposal] }));
    renderWithIntl(
      <ConductorChatPane templates={[approvalTemplate, reportTemplate]} onUseTemplateProposal={vi.fn()} />,
    );
    await sendMessage();

    expect(await screen.findByText('Template suggestions')).toBeInTheDocument();
    expect(screen.getByText('Expense approval')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('Matches the approval flow you described.')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 slots prefilled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use template' })).toBeInTheDocument();
  });

  it('hands off templateId, version and prefill on "Use template"', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult({ templateProposals: [approvalProposal] }));
    const onUse = vi.fn();
    renderWithIntl(<ConductorChatPane templates={[approvalTemplate]} onUseTemplateProposal={onUse} />);
    await sendMessage();

    await userEvent.click(await screen.findByRole('button', { name: 'Use template' }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'expense-approval',
        version: 2,
        prefill: { roles: { approver: 'ops-lead', undeclared: 'x' } },
      }),
    );
  });

  it('renders a turn without proposals exactly as before (regression)', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult());
    renderWithIntl(<ConductorChatPane templates={[approvalTemplate]} onUseTemplateProposal={vi.fn()} />);
    await sendMessage();

    expect(await screen.findByText('Here is a first draft.')).toBeInTheDocument();
    expect(screen.queryByText('Template suggestions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use template' })).not.toBeInTheDocument();
  });

  it('caps rendering at 3 proposal cards', async () => {
    // 5 distinct catalog entries, one proposal each (keys are template ids).
    const extraTemplates: ConductorTemplate[] = [1, 2, 3, 4, 5].map((n) => ({
      ...reportTemplate,
      id: `tpl-${n}`,
      name: `Template ${n}`,
    }));
    const proposals: ConductorTemplateProposal[] = extraTemplates.map((tpl) => ({
      templateId: tpl.id,
      version: 1,
      reason: `fits ${tpl.id}`,
      prefill: {},
    }));
    expect(proposals).toHaveLength(5);
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult({ templateProposals: proposals }));
    renderWithIntl(<ConductorChatPane templates={extraTemplates} onUseTemplateProposal={vi.fn()} />);
    await sendMessage();

    expect(await screen.findByText('Template suggestions')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Use template' })).toHaveLength(3);
  });

  it('degrades a proposal whose template is not in the catalog to plain text', async () => {
    const stray: ConductorTemplateProposal = {
      templateId: 'vanished',
      version: 1,
      reason: 'A template that is no longer visible.',
      prefill: {},
    };
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult({ templateProposals: [stray] }));
    renderWithIntl(<ConductorChatPane templates={[approvalTemplate]} onUseTemplateProposal={vi.fn()} />);
    await sendMessage();

    expect(await screen.findByText('A template that is no longer visible.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use template' })).not.toBeInTheDocument();
  });
});

const DRAFT_WITH_GAPS = {
  entryStepId: 'fetch',
  steps: [
    { id: 'fetch', kind: 'action', actionId: 'pleo.list_missing_receipts' },
    { id: 'notify', kind: 'human', human: { principal: { kind: 'user', ref: 'Teresita Biel' }, channel: 'slack', message: 'Beleg?' } },
  ],
  transitions: [],
  triggers: [{ id: 'tr', kind: 'manual' }],
};

const teresita = { principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel', channelType: 'teams', email: 'teresita.biel@byte5.de' };

function lastGraph(onShow: ReturnType<typeof vi.fn>): { steps: Array<Record<string, unknown>> } {
  return onShow.mock.calls.at(-1)?.[0] as { steps: Array<Record<string, unknown>> };
}

describe('ConductorChatPane missing connectors + people', () => {
  it('renders a missing-connector card, opens the modal with the vendor query, and writes the picked tool id into the step', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(
      turnResult({
        graph: DRAFT_WITH_GAPS,
        missingCapabilities: [{ stepId: 'fetch', kind: 'action', ref: 'pleo.list_missing_receipts', suggestedQuery: 'pleo' }],
      }),
    );
    const onShow = vi.fn();
    renderWithIntl(<ConductorChatPane onShowInDesigner={onShow} />);
    await sendMessage();

    expect(await screen.findByText('Missing connectors')).toBeInTheDocument();
    expect(screen.getByText('pleo.list_missing_receipts')).toBeInTheDocument();
    expect(screen.getByText(/1 connector\(s\) missing/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Connect MCP server' }));
    expect(screen.getByTestId('add-server-modal')).toHaveAttribute('data-query', 'pleo');
    await userEvent.click(screen.getByRole('button', { name: 'pick-tool' }));

    expect(screen.queryByTestId('add-server-modal')).not.toBeInTheDocument();
    expect(screen.getByText(/Step fetch now uses/)).toBeInTheDocument();
    expect(screen.queryByText(/connector\(s\) missing/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    expect(lastGraph(onShow).steps[0]?.actionId).toBe('mcp:srv-1:list_missing_receipts');

    // Change → modal re-opens at the connected server; Reset → the builder's ref is back.
    await userEvent.click(screen.getByRole('button', { name: 'Change tool' }));
    expect(screen.getByTestId('add-server-modal')).toHaveAttribute('data-initial-server', 'srv-1');
    await userEvent.click(screen.getByRole('button', { name: 'pick-tool' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('button', { name: 'Connect MCP server' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    expect(lastGraph(onShow).steps[0]?.actionId).toBe('pleo.list_missing_receipts');
  });

  it('person candidates are proposals: nothing is written until the operator clicks, then ref AND channel change', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(
      turnResult({
        graph: DRAFT_WITH_GAPS,
        personSuggestions: [{ stepId: 'notify', query: 'Teresita Biel', candidates: [teresita], partial: false }],
      }),
    );
    const onShow = vi.fn();
    renderWithIntl(<ConductorChatPane onShowInDesigner={onShow} />);
    await sendMessage();

    expect(await screen.findByText('People')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    expect((lastGraph(onShow).steps[1] as { human: { principal: { ref: string } } }).human.principal.ref).toBe('Teresita Biel');

    await userEvent.click(screen.getByRole('button', { name: /Teresita Biel/ }));
    expect(screen.getByText('Applied: Teresita Biel')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    const human = (lastGraph(onShow).steps[1] as { human: { principal: { ref: string }; channel: string } }).human;
    expect(human.principal.ref).toBe('teresita.biel@byte5.de');
    expect(human.channel).toBe('teams');

    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    const restored = (lastGraph(onShow).steps[1] as { human: { principal: { ref: string }; channel: string } }).human;
    expect(restored.principal.ref).toBe('Teresita Biel');
    expect(restored.channel).toBe('slack');
  });

  it('cards of an earlier turn are retired once a new turn arrives (step ids may have changed)', async () => {
    vi.mocked(conductorBuilderTurn)
      .mockResolvedValueOnce(
        turnResult({ graph: DRAFT_WITH_GAPS, missingCapabilities: [{ stepId: 'fetch', kind: 'action', ref: 'pleo.list_missing_receipts', suggestedQuery: 'pleo' }] }),
      )
      .mockResolvedValueOnce(turnResult({ graph: DRAFT_WITH_GAPS, reply: 'Second draft.' }));
    renderWithIntl(<ConductorChatPane />);
    await sendMessage();
    expect(await screen.findByRole('button', { name: 'Connect MCP server' })).toBeInTheDocument();
    // The composer debounces sends 350ms apart; a second send inside that window is dropped by design.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await sendMessage();
    expect(await screen.findByText('Second draft.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect MCP server' })).not.toBeInTheDocument();
    expect(screen.queryByText(/connector\(s\) missing/)).not.toBeInTheDocument();
  });

  it('shows the partial-directory hint and the not-found line', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(
      turnResult({ graph: DRAFT_WITH_GAPS, personSuggestions: [{ stepId: 'notify', query: 'Teresita Biel', candidates: [], partial: true }] }),
    );
    renderWithIntl(<ConductorChatPane />);
    await sendMessage();
    expect(await screen.findByText(/Not found in the directory/)).toBeInTheDocument();
    expect(screen.getByText(/Directory incomplete/)).toBeInTheDocument();
  });

  it('renders a turn without the new fields exactly as before (v1 regression)', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(turnResult());
    renderWithIntl(<ConductorChatPane />);
    await sendMessage();
    expect(await screen.findByText('Here is a first draft.')).toBeInTheDocument();
    expect(screen.queryByText('Missing connectors')).not.toBeInTheDocument();
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });
});

describe('ConductorChatPane draft persistence', () => {
  it('persists transcript, graph and picks to localStorage and hydrates them on a fresh mount; "New draft" clears', async () => {
    vi.mocked(conductorBuilderTurn).mockResolvedValue(
      turnResult({ graph: DRAFT_WITH_GAPS, personSuggestions: [{ stepId: 'notify', query: 'Teresita Biel', candidates: [teresita], partial: false }] }),
    );
    const first = renderWithIntl(<ConductorChatPane />);
    await sendMessage();
    await userEvent.click(await screen.findByRole('button', { name: /Teresita Biel/ }));
    expect(screen.getByText('Applied: Teresita Biel')).toBeInTheDocument();
    expect(window.localStorage.getItem('omadia.conductor.chatDraft.v1')).toContain('teresita.biel@byte5.de');
    first.unmount();

    const onShow = vi.fn();
    renderWithIntl(<ConductorChatPane onShowInDesigner={onShow} />);
    expect(await screen.findByText('Here is a first draft.')).toBeInTheDocument();
    expect(screen.getByText('Applied: Teresita Biel')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in designer' }));
    expect((lastGraph(onShow).steps[1] as { human: { principal: { ref: string } } }).human.principal.ref).toBe('teresita.biel@byte5.de');

    await userEvent.click(screen.getByRole('button', { name: 'New draft' }));
    expect(screen.queryByText('Here is a first draft.')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('omadia.conductor.chatDraft.v1')).toBeNull();
  });
});
