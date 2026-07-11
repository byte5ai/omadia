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
