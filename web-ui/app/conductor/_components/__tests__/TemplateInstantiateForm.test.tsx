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
  type ConductorTemplateSlotMapping,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { TemplateInstantiateForm } from '../TemplateInstantiateForm';
import { TemplateUpdateHint } from '../TemplateUpdateHint';

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

// jsdom cannot drive @xyflow/react's measured canvas (imported via the form's
// collapsed-by-default TemplatePreview) — stub the flow surface with inert
// elements; the preview's own render contract is covered in TemplatePreview.test.
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="flow-canvas" />,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));

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
    onOpenInDesigner: (graph: unknown, target: { slug: string; name: string; enable: boolean }) => void;
    onCancel: () => void;
  }> = {},
  extra: Partial<{ version: number; initialMapping: ConductorTemplateSlotMapping }> = {},
): ReturnType<typeof renderWithIntl> {
  return renderWithIntl(
    <TemplateInstantiateForm
      template={template}
      onCreated={handlers.onCreated ?? vi.fn()}
      onOpenInDesigner={handlers.onOpenInDesigner ?? vi.fn()}
      onCancel={handlers.onCancel ?? vi.fn()}
      version={extra.version}
      initialMapping={extra.initialMapping}
    />,
  );
}

/** cronTemplate plus declared text slots: one with a default, one required-fill. */
const textTemplate: ConductorTemplate = {
  ...cronTemplate,
  id: 'weekly-report-text',
  slots: {
    agents: [{ key: 'reporter', label: 'Report writer' }],
    text: [
      { key: 'tone', label: 'Tone of voice', description: 'How the report should read.', default: 'concise' },
      { key: 'audience', label: 'Audience' },
    ],
  },
};

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

  it('resolves the template and hands the graph plus the instance slug/name/enable to onOpenInDesigner', async () => {
    const user = userEvent.setup();
    const onOpenInDesigner = vi.fn();
    const resolvedGraph = { entryStepId: 'submit', steps: [], transitions: [] };
    vi.mocked(resolveConductorTemplate).mockResolvedValue({ graph: resolvedGraph });
    renderForm(approvalTemplate, { onOpenInDesigner });

    await fillAllSlots(user);
    // Edit the prefilled identity so the assertion proves the FORM values travel
    // (trimmed), not the template defaults.
    const slugField = screen.getByRole('textbox', { name: 'Workflow slug' });
    await user.clear(slugField);
    await user.type(slugField, 'q3-expenses');
    const nameField = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(nameField);
    await user.type(nameField, 'Q3 expenses ');
    await user.click(screen.getByRole('button', { name: 'Open in designer' }));

    expect(resolveConductorTemplate).toHaveBeenCalledWith('expense-approval', {
      roles: { approver: 'finance-lead' },
      agents: { classifier: 'expense-bot' },
      channels: { notify: 'teams' },
    });
    await waitFor(() => {
      // enable: false = the untouched default-off toggle — it must travel with the
      // handoff so the canvas's Save can't silently enable the workflow.
      expect(onOpenInDesigner).toHaveBeenCalledWith(resolvedGraph, {
        slug: 'q3-expenses',
        name: 'Q3 expenses',
        enable: false,
      });
    });
  });

  it('hands enable: true to onOpenInDesigner when the operator opted in', async () => {
    const user = userEvent.setup();
    const onOpenInDesigner = vi.fn();
    const resolvedGraph = { entryStepId: 'compile', steps: [], transitions: [] };
    vi.mocked(resolveConductorTemplate).mockResolvedValue({ graph: resolvedGraph });
    renderForm(cronTemplate, { onOpenInDesigner });

    await user.selectOptions(await screen.findByRole('combobox', { name: /Report writer/ }), 'expense-bot');
    await user.click(screen.getByRole('checkbox', { name: 'Enable the workflow right away' }));
    await user.click(screen.getByRole('button', { name: 'Open in designer' }));

    await waitFor(() => {
      expect(onOpenInDesigner).toHaveBeenCalledWith(resolvedGraph, {
        slug: 'weekly-report',
        name: 'Weekly report',
        enable: true,
      });
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

  it('renders German slot labels, help texts, and the prefilled localized name under de', async () => {
    const localizedTemplate: ConductorTemplate = {
      ...approvalTemplate,
      name: { en: 'Expense approval', de: 'Spesenfreigabe' },
      description: {
        en: 'Route an expense to the right approver, with escalation above a threshold.',
        de: 'Leitet Spesen an die richtige Freigaberolle, mit Eskalation oberhalb eines Schwellwerts.',
      },
      slots: {
        roles: [
          {
            key: 'approver',
            label: { en: 'Approver', de: 'Freigaberolle' },
            description: { en: 'Who signs off expenses.', de: 'Wer Spesen freigibt.' },
          },
        ],
        // Plain-string slot metadata must keep working alongside localized records.
        agents: [{ key: 'classifier', label: 'Expense classifier' }],
      },
    };
    renderWithIntl(
      <TemplateInstantiateForm template={localizedTemplate} onCreated={vi.fn()} onOpenInDesigner={vi.fn()} onCancel={vi.fn()} />,
      { locale: 'de' },
    );

    expect(await screen.findByRole('combobox', { name: /Freigaberolle/ })).toBeInTheDocument();
    expect(screen.getByText('Wer Spesen freigibt.')).toBeInTheDocument();
    expect(screen.getByText('Spesenfreigabe', { exact: false })).toBeInTheDocument(); // form heading
    expect(screen.getByText(/Leitet Spesen an die richtige Freigaberolle/)).toBeInTheDocument();
    // Prefilled workflow name resolves to the active locale's reading.
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Spesenfreigabe');
    // No raw English metadata leaks through under de.
    expect(screen.queryByText('Who signs off expenses.')).not.toBeInTheDocument();
    // Untranslated plain-string slot label falls back to its only (English) form.
    expect(screen.getByRole('combobox', { name: /Expense classifier/ })).toBeInTheDocument();
  });

  it('falls back to English under de when a localized record has no de entry', async () => {
    const partiallyLocalized: ConductorTemplate = {
      ...approvalTemplate,
      name: { en: 'Expense approval' },
      slots: { roles: [{ key: 'approver', label: { en: 'Approver' } }] },
    };
    renderWithIntl(
      <TemplateInstantiateForm template={partiallyLocalized} onCreated={vi.fn()} onOpenInDesigner={vi.fn()} onCancel={vi.fn()} />,
      { locale: 'de' },
    );

    expect(await screen.findByRole('combobox', { name: /Approver/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Expense approval');
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

describe('<TemplateInstantiateForm /> text slots (#478)', () => {
  it('renders one input per declared text slot, with the default prefilled', async () => {
    renderForm(textTemplate);

    const group = await screen.findByRole('group', { name: 'Text slots' });
    expect(within(group).getByRole('textbox', { name: /Tone of voice/ })).toHaveValue('concise');
    expect(within(group).getByText('How the report should read.')).toBeInTheDocument();
    expect(within(group).getByRole('textbox', { name: 'Audience' })).toHaveValue('');
  });

  it('blocks submit while a defaultless text slot is empty and sends the text record once filled', async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockResolvedValue({
      workflow: { slug: 'weekly-report' } as never,
      version: { id: 'v1', version: 1 },
    });
    renderForm(textTemplate);

    await user.selectOptions(await screen.findByRole('combobox', { name: /Report writer/ }), 'expense-bot');
    // 'audience' has no default → the gate stays armed until it holds a value.
    const create = screen.getByRole('button', { name: 'Create workflow' });
    expect(create).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Audience' }), 'quarterly investors');
    expect(create).toBeEnabled();
    await user.click(create);

    expect(instantiateConductorTemplate).toHaveBeenCalledWith('weekly-report-text', {
      slug: 'weekly-report',
      name: 'Weekly report',
      mapping: {
        agents: { reporter: 'expense-bot' },
        text: { tone: 'concise', audience: 'quarterly investors' },
      },
      enable: false,
    });
  });

  it('stays submittable with an EMPTY defaulted text slot and omits it from the mapping (server default wins)', async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockResolvedValue({
      workflow: { slug: 'weekly-report' } as never,
      version: { id: 'v1', version: 1 },
    });
    renderForm(textTemplate);

    await user.selectOptions(await screen.findByRole('combobox', { name: /Report writer/ }), 'expense-bot');
    await user.clear(screen.getByRole('textbox', { name: /Tone of voice/ }));
    await user.type(screen.getByRole('textbox', { name: 'Audience' }), 'board');
    const create = screen.getByRole('button', { name: 'Create workflow' });
    expect(create).toBeEnabled();
    await user.click(create);

    const body = vi.mocked(instantiateConductorTemplate).mock.calls[0]?.[1];
    // The emptied 'tone' key is omitted so the server substitutes the declared default.
    expect(body?.mapping.text).toEqual({ audience: 'board' });
  });

  it("maps a server kind:'text' incomplete-mapping entry onto the right text field", async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockRejectedValue(
      new ApiError(
        400,
        'POST failed: 400',
        JSON.stringify({
          code: 'conductor.template_slot_mapping_incomplete',
          missing: [{ kind: 'text', key: 'audience', label: 'Audience' }],
        }),
      ),
    );
    renderForm(textTemplate);

    await user.selectOptions(await screen.findByRole('combobox', { name: /Report writer/ }), 'expense-bot');
    // Client gate passes (spaces), the authoritative server still rejects.
    await user.type(screen.getByRole('textbox', { name: 'Audience' }), 'x');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));

    expect(await screen.findByText('Enter a value for this text slot.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Audience/ })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: /Tone of voice/ })).not.toHaveAttribute('aria-invalid');
  });
});

describe('<TemplateInstantiateForm /> version pin + prefill + preview (#478)', () => {
  it('shows the pinned version in the header and passes it to resolve and instantiate', async () => {
    const user = userEvent.setup();
    vi.mocked(instantiateConductorTemplate).mockResolvedValue({
      workflow: { slug: 'weekly-report' } as never,
      version: { id: 'v1', version: 1 },
    });
    vi.mocked(resolveConductorTemplate).mockResolvedValue({ graph: { entryStepId: 'compile', steps: [] } });
    renderForm(cronTemplate, {}, { version: 3 });

    expect(screen.getByText('v3')).toBeInTheDocument();

    await user.selectOptions(await screen.findByRole('combobox', { name: /Report writer/ }), 'expense-bot');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(instantiateConductorTemplate).toHaveBeenCalledWith(
      'weekly-report',
      expect.objectContaining({ version: 3 }),
    );

    await user.click(screen.getByRole('button', { name: 'Open in designer' }));
    await waitFor(() => {
      expect(resolveConductorTemplate).toHaveBeenCalledWith('weekly-report', { agents: { reporter: 'expense-bot' } }, 3);
    });
  });

  it('falls back to the manifest version in the header when nothing is pinned', () => {
    renderForm({ ...cronTemplate, version: 2 });
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('seeds the mapping from an initial prefill (chat proposals) while keeping every field editable', async () => {
    renderForm(textTemplate, {}, { initialMapping: { agents: { reporter: 'expense-bot' }, text: { audience: 'board' } } });

    expect(await screen.findByRole('combobox', { name: /Report writer/ })).toHaveValue('expense-bot');
    // Prefill wins over the declared default only where it supplies a value.
    expect(screen.getByRole('textbox', { name: 'Audience' })).toHaveValue('board');
    expect(screen.getByRole('textbox', { name: /Tone of voice/ })).toHaveValue('concise');
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeEnabled();
  });

  it('mounts the graph preview only behind the collapsed-by-default toggle', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.queryByTestId('template-preview')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Preview graph' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByTestId('template-preview')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(screen.queryByTestId('template-preview')).not.toBeInTheDocument();
  });
});

describe('<TemplateUpdateHint /> (#478)', () => {
  const hint = { id: 'weekly-report', version: 1, latestVersion: 2, updateAvailable: true };

  it('renders the update text and hands (templateId, latestVersion) to onReinstantiate', async () => {
    const user = userEvent.setup();
    const onReinstantiate = vi.fn();
    renderWithIntl(<TemplateUpdateHint hint={hint} onReinstantiate={onReinstantiate} />);

    expect(screen.getByText('Template updated (v1 → v2)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-instantiate from v2' }));
    // The page wires this to open the instantiate form pinned to latestVersion —
    // the pin's passthrough is covered by the version tests above.
    expect(onReinstantiate).toHaveBeenCalledWith('weekly-report', 2);
  });

  it('renders nothing while no update is available', () => {
    const { container } = renderWithIntl(
      <TemplateUpdateHint hint={{ ...hint, latestVersion: 1, updateAvailable: false }} onReinstantiate={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
