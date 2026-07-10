import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  getConductorAgents,
  getConductorRoles,
  instantiateConductorTemplate,
  resolveConductorTemplate,
  type ConductorTemplate,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { TemplateInstantiateForm } from '../TemplateInstantiateForm';

// Partial mock: only the network layer is stubbed — ApiError (used for the error-
// envelope mapping tests) and the wire types stay real.
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    getConductorRoles: vi.fn(),
    getConductorAgents: vi.fn(),
    getConductorActions: vi.fn(),
    getConductorEventCatalog: vi.fn(),
    instantiateConductorTemplate: vi.fn(),
    resolveConductorTemplate: vi.fn(),
  };
});

const approvalTemplate: ConductorTemplate = {
  id: 'expense-approval',
  name: 'Expense approval',
  description: 'Route an expense to the right approver, with escalation above a threshold.',
  useCase: 'approval',
  defaultSlug: 'expense-approval',
  graph: {
    entryStepId: 'submit',
    steps: [],
    transitions: [],
    triggers: [{ id: 't1', kind: 'event', eventId: 'slot:event:expense-submitted' }],
  },
  slots: {
    roles: [{ key: 'approver', label: 'Approver', description: 'Who signs off expenses.' }],
    agents: [{ key: 'classifier', label: 'Expense classifier' }],
    channels: [{ key: 'notify', label: 'Notification channel' }],
  },
};

const cronTemplate: ConductorTemplate = {
  id: 'weekly-report',
  name: 'Weekly report',
  description: 'Compile and deliver a status report every week.',
  useCase: 'reporting',
  defaultSlug: 'weekly-report',
  graph: {
    entryStepId: 'compile',
    steps: [],
    transitions: [],
    triggers: [{ id: 't1', kind: 'cron', cron: '0 9 * * 1' }],
  },
  slots: {
    agents: [{ key: 'reporter', label: 'Report writer' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConductorRoles).mockResolvedValue({ roles: [{ key: 'finance-lead', label: 'Finance lead' }] });
  vi.mocked(getConductorAgents).mockResolvedValue({ agents: [{ slug: 'expense-bot', name: 'Expense bot' }] });
});

function renderForm(
  template: ConductorTemplate = approvalTemplate,
  handlers: Partial<{
    onCreated: (slug: string) => void;
    onOpenInDesigner: (graph: unknown) => void;
    onCancel: () => void;
  }> = {},
): ReturnType<typeof renderWithIntl> {
  return renderWithIntl(
    <TemplateInstantiateForm
      template={template}
      onCreated={handlers.onCreated ?? vi.fn()}
      onOpenInDesigner={handlers.onOpenInDesigner ?? vi.fn()}
      onCancel={handlers.onCancel ?? vi.fn()}
    />,
  );
}

/** Fill every declared slot of approvalTemplate (channel is prefilled with 'teams'). */
async function fillAllSlots(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.selectOptions(await screen.findByRole('combobox', { name: /Approver/ }), 'finance-lead');
  await user.selectOptions(screen.getByRole('combobox', { name: /Expense classifier/ }), 'expense-bot');
}

describe('<TemplateInstantiateForm />', () => {
  it('renders one picker per declared slot with label and description, grouped by kind', async () => {
    renderForm();

    const rolesGroup = screen.getByRole('group', { name: 'Roles' });
    expect(await within(rolesGroup).findByRole('combobox', { name: /Approver/ })).toBeInTheDocument();
    expect(within(rolesGroup).getByText('Who signs off expenses.')).toBeInTheDocument();

    const agentsGroup = screen.getByRole('group', { name: 'Agents' });
    expect(within(agentsGroup).getByRole('combobox', { name: /Expense classifier/ })).toBeInTheDocument();

    // Channels reuse the shared ChannelSelect (known delivery channels).
    const channelsGroup = screen.getByRole('group', { name: 'Channels' });
    const channelSelect = within(channelsGroup).getByRole('combobox', { name: 'Notification channel' });
    expect(within(channelSelect).getByRole('option', { name: 'teams' })).toBeInTheDocument();

    // Undeclared kinds render no group.
    expect(screen.queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Events' })).not.toBeInTheDocument();
  });

  it('keeps both submit actions disabled until the slug and every slot have a value', async () => {
    const user = userEvent.setup();
    renderForm();

    const create = screen.getByRole('button', { name: 'Create workflow' });
    const openInDesigner = screen.getByRole('button', { name: 'Open in designer' });
    expect(create).toBeDisabled();
    expect(openInDesigner).toBeDisabled();

    await fillAllSlots(user);
    expect(create).toBeEnabled();
    expect(openInDesigner).toBeEnabled();

    // Emptying the slug re-arms the gate.
    await user.clear(screen.getByRole('textbox', { name: 'Workflow slug' }));
    expect(create).toBeDisabled();
    expect(openInDesigner).toBeDisabled();
  });

  it('creates the workflow with the exact body and reports the slug on success', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.mocked(instantiateConductorTemplate).mockResolvedValue({
      workflow: { slug: 'expense-approval' } as never,
      version: { id: 'v1', version: 1 },
    });
    renderForm(approvalTemplate, { onCreated });

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));

    expect(instantiateConductorTemplate).toHaveBeenCalledWith('expense-approval', {
      slug: 'expense-approval',
      name: 'Expense approval',
      mapping: {
        roles: { approver: 'finance-lead' },
        agents: { classifier: 'expense-bot' },
        channels: { notify: 'teams' },
      },
      enable: false,
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('expense-approval');
    });
  });

  it('flags each missing slot inline on a 400 slot-mapping-incomplete envelope', async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockRejectedValue(
      new ApiError(
        400,
        'POST failed: 400',
        JSON.stringify({
          code: 'conductor.template_slot_mapping_incomplete',
          missing: [{ kind: 'roles', key: 'approver', label: 'Approver' }],
        }),
      ),
    );
    renderForm();

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));

    expect(await screen.findByText('Select a value for this slot.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Approver/ })).toHaveAttribute('aria-invalid', 'true');
    // The other slots stay unflagged.
    expect(screen.getByRole('combobox', { name: /Expense classifier/ })).not.toHaveAttribute('aria-invalid');
  });

  it('puts a 409 slug collision on the slug field', async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockRejectedValue(
      new ApiError(
        409,
        'POST failed: 409',
        JSON.stringify({ code: 'conductor.slug_exists', message: "a workflow with slug 'expense-approval' already exists" }),
      ),
    );
    renderForm();

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));

    expect(
      await screen.findByText('A workflow with this slug already exists — choose a different slug.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Workflow slug/ })).toHaveAttribute('aria-invalid', 'true');
  });

  it('lists graph-validation errors under the form on a 400 invalid-graph envelope', async () => {
    const user = userEvent.setup();
    vi.mocked(resolveConductorTemplate).mockRejectedValue(
      new ApiError(
        400,
        'POST failed: 400',
        JSON.stringify({
          code: 'conductor.invalid_graph',
          errors: [{ code: 'unknown_agent_ref', message: "step 'classify' references unknown agent 'ghost'", nodeIds: ['classify'] }],
        }),
      ),
    );
    renderForm();

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Open in designer' }));

    expect(await screen.findByText('The resolved workflow failed validation:')).toBeInTheDocument();
    expect(screen.getByText("step 'classify' references unknown agent 'ghost'")).toBeInTheDocument();
  });

  it('resolves the template and hands the returned graph to onOpenInDesigner', async () => {
    const user = userEvent.setup();
    const onOpenInDesigner = vi.fn();
    const resolvedGraph = { entryStepId: 'submit', steps: [], transitions: [] };
    vi.mocked(resolveConductorTemplate).mockResolvedValue({ graph: resolvedGraph });
    renderForm(approvalTemplate, { onOpenInDesigner });

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Open in designer' }));

    expect(resolveConductorTemplate).toHaveBeenCalledWith('expense-approval', {
      roles: { approver: 'finance-lead' },
      agents: { classifier: 'expense-bot' },
      channels: { notify: 'teams' },
    });
    await waitFor(() => {
      expect(onOpenInDesigner).toHaveBeenCalledWith(resolvedGraph);
    });
  });

  it('shows the schedule notice only for a cron template with enable ON', async () => {
    const user = userEvent.setup();
    const notice =
      'This template runs on a schedule. Enabling it starts the schedule as soon as the workflow is created.';

    const { unmount } = renderForm(cronTemplate);
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Enable the workflow right away' }));
    expect(screen.getByText(notice)).toBeInTheDocument();
    unmount();

    // Non-cron template: never shown, even with enable ON.
    renderForm(approvalTemplate);
    await user.click(screen.getByRole('checkbox', { name: 'Enable the workflow right away' }));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it('swaps the pending button label to verb + animated dots, never a spinner', async () => {
    const user = userEvent.setup();
    // Never settles → the form stays in its in-flight state for the assertion.
    vi.mocked(instantiateConductorTemplate).mockReturnValue(new Promise(() => {}));
    const { container } = renderForm();

    await fillAllSlots(user);
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));

    const busyButton = await screen.findByRole('button', { name: /Creating/ });
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(busyButton.querySelector('.lume-busy-dots')).not.toBeNull();
    // Lume: no spinner glyphs or rings anywhere.
    expect(container.querySelector('svg, .animate-spin')).toBeNull();
  });
});
