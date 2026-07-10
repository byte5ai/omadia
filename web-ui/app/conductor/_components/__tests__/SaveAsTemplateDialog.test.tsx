import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createConductorTemplate,
  fetchConductorTemplate,
  saveWorkflowAsTemplate,
  updateConductorTemplate,
  type ConductorTemplate,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { SaveAsTemplateDialog } from '../SaveAsTemplateDialog';

// Partial mock: only the network layer is stubbed — ApiError (for the 409-race
// test) and the wire types stay real.
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    saveWorkflowAsTemplate: vi.fn(),
    createConductorTemplate: vi.fn(),
    updateConductorTemplate: vi.fn(),
    fetchConductorTemplate: vi.fn(),
  };
});

const VIEWER = 'user-1';

/** The backend's inference draft: one declared slot per distinct concrete ref,
 *  proposed label = the original ref (inferTemplateManifest's contract). */
const inferredDraft: ConductorTemplate = {
  id: 'expense-flow',
  name: 'Expense flow',
  description: 'Route expenses to an approver.',
  useCase: 'general',
  defaultSlug: 'expense-flow',
  graph: {
    entryStepId: 'submit',
    steps: [
      { id: 'submit', kind: 'agent', agentId: 'slot:agent:expense-bot', prompt: 'Collect the expense report.' },
      {
        id: 'approve',
        kind: 'human',
        human: { principal: { kind: 'role', ref: 'slot:role:finance-lead' }, channel: 'teams', message: 'Approve the expense?' },
      },
    ],
    transitions: [{ id: 't1', source: 'submit', target: 'approve' }],
    triggers: [],
  },
  slots: {
    roles: [{ key: 'finance-lead', label: 'finance-lead' }],
    agents: [{ key: 'expense-bot', label: 'expense-bot' }],
  },
};

/** Viewer-scoped catalog for the ownership pre-check. */
const ownedTemplate: ConductorTemplate = {
  ...inferredDraft,
  id: 'expense-flow-owned',
  source: 'user',
  status: 'private',
  createdBy: VIEWER,
  version: 1,
  latestVersion: 1,
  instantiationCount: 0,
};

const bundledTemplate: ConductorTemplate = {
  ...inferredDraft,
  id: 'bundled-template',
  source: 'bundled',
  version: 1,
  latestVersion: 1,
  instantiationCount: 3,
};

const foreignSharedTemplate: ConductorTemplate = {
  ...inferredDraft,
  id: 'foreign-shared',
  source: 'user',
  status: 'shared',
  createdBy: 'someone-else',
  version: 2,
  latestVersion: 2,
  instantiationCount: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveWorkflowAsTemplate).mockResolvedValue({
    draft: structuredClone(inferredDraft),
    sourceWorkflow: { slug: 'expense-flow', version: 3 },
  });
});

function renderDialog(
  handlers: Partial<{
    onPublished: (result: { id: string; version: number }) => void;
    onCancel: () => void;
  }> = {},
  overrides: Partial<{ templates: ConductorTemplate[]; viewer: string | null }> = {},
): ReturnType<typeof renderWithIntl> {
  return renderWithIntl(
    <SaveAsTemplateDialog
      workflowSlug="expense-flow"
      templates={overrides.templates ?? [ownedTemplate, bundledTemplate, foreignSharedTemplate]}
      viewer={overrides.viewer !== undefined ? overrides.viewer : VIEWER}
      onPublished={handlers.onPublished ?? vi.fn()}
      onCancel={handlers.onCancel ?? vi.fn()}
    />,
  );
}

async function idField(): Promise<HTMLElement> {
  return screen.findByRole('textbox', { name: 'Template id' });
}

describe('<SaveAsTemplateDialog />', () => {
  it('renders the inferred draft: one group per slot with kind badge, key, original ref, editable labels', async () => {
    renderDialog();

    const roleGroup = await screen.findByRole('group', { name: /finance-lead/ });
    expect(within(roleGroup).getByText('Roles')).toBeInTheDocument();
    expect(within(roleGroup).getByText('was: finance-lead')).toBeInTheDocument();
    // The proposed label (= the concrete ref) is prefilled and editable.
    const labelInput = within(roleGroup).getByRole('textbox', { name: 'Label (English)' });
    expect(labelInput).toHaveValue('finance-lead');
    expect(labelInput).toBeEnabled();

    const agentGroup = screen.getByRole('group', { name: /expense-bot/ });
    expect(within(agentGroup).getByText('Agents')).toBeInTheDocument();

    // Metadata is seeded from the draft; a fresh id publishes as a NEW template.
    expect(screen.getByRole('textbox', { name: 'Template id' })).toHaveValue('expense-flow');
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeEnabled();
  });

  it('publishes an unused id via POST with the edited manifest (labels, de map, text slot)', async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    vi.mocked(createConductorTemplate).mockImplementation(async (manifest) => ({
      template: { ...manifest, version: 1, latestVersion: 1 },
    }));
    renderDialog({ onPublished });

    // Edit the role slot's label (en) and add a German reading.
    const roleGroup = await screen.findByRole('group', { name: /finance-lead/ });
    const labelEn = within(roleGroup).getByRole('textbox', { name: 'Label (English)' });
    await user.clear(labelEn);
    await user.type(labelEn, 'Finance approver');
    await user.type(within(roleGroup).getByRole('textbox', { name: 'Label (German)' }), 'Freigaberolle');

    // Declare a text slot with a default; the token hint shows the paste-able form.
    await user.click(screen.getByRole('button', { name: '+ Add text slot' }));
    const textGroup = screen.getByRole('group', { name: /slot:text:/ });
    // While the key is empty its inline hint extends the accessible name — match by prefix.
    await user.type(within(textGroup).getByRole('textbox', { name: /^Key/ }), 'region');
    await user.type(within(textGroup).getByRole('textbox', { name: 'Label (English)' }), 'Region');
    await user.type(within(textGroup).getByRole('textbox', { name: 'Default value (optional)' }), 'EMEA');
    expect(screen.getByText('Token: slot:text:region')).toBeInTheDocument();

    // Place the token into the agent step's prompt via the insert button (one
    // button per step-text field; the prompt field renders first).
    await user.click(screen.getAllByRole('button', { name: 'Insert slot:text:region' })[0]!);

    await user.click(screen.getByRole('button', { name: 'Publish template' }));

    expect(createConductorTemplate).toHaveBeenCalledWith({
      id: 'expense-flow',
      name: 'Expense flow',
      description: 'Route expenses to an approver.',
      useCase: 'general',
      defaultSlug: 'expense-flow',
      graph: {
        ...inferredDraft.graph,
        steps: [
          { id: 'submit', kind: 'agent', agentId: 'slot:agent:expense-bot', prompt: 'Collect the expense report. slot:text:region' },
          {
            id: 'approve',
            kind: 'human',
            human: { principal: { kind: 'role', ref: 'slot:role:finance-lead' }, channel: 'teams', message: 'Approve the expense?' },
          },
        ],
      },
      slots: {
        roles: [{ key: 'finance-lead', label: { en: 'Finance approver', de: 'Freigaberolle' } }],
        agents: [{ key: 'expense-bot', label: 'expense-bot' }],
        text: [{ key: 'region', label: 'Region', default: 'EMEA' }],
      },
    });
    expect(updateConductorTemplate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith({ id: 'expense-flow', version: 1 });
    });
  });

  it('blocks publish while a declared text slot has no placed token, and unblocks after insertion', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole('button', { name: '+ Add text slot' }));
    const textGroup = screen.getByRole('group', { name: /slot:text:/ });
    await user.type(within(textGroup).getByRole('textbox', { name: /^Key/ }), 'greeting');
    await user.type(within(textGroup).getByRole('textbox', { name: 'Label (English)' }), 'Greeting');

    // Declared but unplaced → the backend would reject template_text_slot_unused.
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeDisabled();
    expect(screen.getByText("Insert each text slot's token into at least one step text below.")).toBeInTheDocument();

    // Both designated fields (agent prompt + human message) offer an insert path.
    const inserts = screen.getAllByRole('button', { name: 'Insert slot:text:greeting' });
    expect(inserts).toHaveLength(2);
    await user.click(inserts[1]!); // place it in the human step's message

    expect(screen.queryByText("Insert each text slot's token into at least one step text below.")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message — step approve' })).toHaveValue(
      'Approve the expense? slot:text:greeting',
    );
  });

  it('switches the primary action to "Publish as v2" for an owned existing id and submits via PUT', async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    vi.mocked(updateConductorTemplate).mockImplementation(async (id, manifest) => ({
      template: { ...manifest, id, version: 2, latestVersion: 2 },
    }));
    renderDialog({ onPublished });

    const id = await idField();
    await user.clear(id);
    await user.type(id, 'expense-flow-owned');

    // Owned id → versioned publish, with the copy-not-reference note visible.
    const publishV2 = screen.getByRole('button', { name: 'Publish as v2' });
    expect(publishV2).toBeEnabled();
    expect(screen.getByText(/keep their copy and will show an update hint/)).toBeInTheDocument();

    await user.click(publishV2);

    expect(updateConductorTemplate).toHaveBeenCalledTimes(1);
    expect(updateConductorTemplate).toHaveBeenCalledWith(
      'expense-flow-owned',
      expect.objectContaining({ id: 'expense-flow-owned' }),
    );
    expect(createConductorTemplate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith({ id: 'expense-flow-owned', version: 2 });
    });
  });

  it('shows the inline id-taken error for bundled and foreign ids and sends no request', async () => {
    const user = userEvent.setup();
    renderDialog();

    const id = await idField();
    await user.clear(id);
    await user.type(id, 'bundled-template');
    expect(screen.getByText('This template id is taken.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeDisabled();

    await user.clear(id);
    await user.type(id, 'foreign-shared');
    expect(screen.getByText('This template id is taken.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeDisabled();

    expect(createConductorTemplate).not.toHaveBeenCalled();
    expect(updateConductorTemplate).not.toHaveBeenCalled();
  });

  it('recovers from a 409 race: re-fetches the template and switches into PUT mode when owned', async () => {
    const user = userEvent.setup();
    // The id is fresh in the loaded catalog…
    renderDialog({}, { templates: [] });
    vi.mocked(createConductorTemplate).mockRejectedValue(
      new ApiError(409, 'POST failed: 409', JSON.stringify({ code: 'conductor.template_id_exists' })),
    );
    // …but was created (by this viewer, e.g. in another tab) between load and submit.
    vi.mocked(fetchConductorTemplate).mockResolvedValue({
      template: { ...inferredDraft, source: 'user', status: 'private', createdBy: VIEWER, version: 3, latestVersion: 3 },
    });

    await user.click(await screen.findByRole('button', { name: 'Publish template' }));

    // No dead-end: the dialog flips to the next-version publish instead of an error.
    expect(await screen.findByRole('button', { name: 'Publish as v4' })).toBeEnabled();
    expect(screen.queryByText('This template id is taken.')).not.toBeInTheDocument();

    vi.mocked(updateConductorTemplate).mockImplementation(async (id, manifest) => ({
      template: { ...manifest, id, version: 4, latestVersion: 4 },
    }));
    await user.click(screen.getByRole('button', { name: 'Publish as v4' }));
    expect(updateConductorTemplate).toHaveBeenCalledWith('expense-flow', expect.objectContaining({ id: 'expense-flow' }));
  });

  it('keeps the id-taken dead end when the 409 re-fetch shows a foreign owner', async () => {
    const user = userEvent.setup();
    renderDialog({}, { templates: [] });
    vi.mocked(createConductorTemplate).mockRejectedValue(
      new ApiError(409, 'POST failed: 409', JSON.stringify({ code: 'conductor.template_id_exists' })),
    );
    vi.mocked(fetchConductorTemplate).mockResolvedValue({
      template: { ...inferredDraft, source: 'user', status: 'shared', createdBy: 'someone-else', version: 1, latestVersion: 1 },
    });

    await user.click(await screen.findByRole('button', { name: 'Publish template' }));

    expect(await screen.findByText('This template id is taken.')).toBeInTheDocument();
    expect(updateConductorTemplate).not.toHaveBeenCalled();
  });

  it('produces a LocalizedText map from the de metadata inputs and blocks submit without en', async () => {
    const user = userEvent.setup();
    vi.mocked(createConductorTemplate).mockImplementation(async (manifest) => ({
      template: { ...manifest, version: 1, latestVersion: 1 },
    }));
    renderDialog();

    const nameEn = await screen.findByRole('textbox', { name: 'Name (English)' });
    await user.type(screen.getByRole('textbox', { name: 'Name (German)' }), 'Spesenfluss');

    // Clearing the English base blocks submit (en is the universal fallback).
    await user.clear(nameEn);
    expect(screen.getByRole('button', { name: 'Publish template' })).toBeDisabled();
    expect(
      screen.getByText('English is required for the name, description, use case and every slot label.'),
    ).toBeInTheDocument();
    expect(createConductorTemplate).not.toHaveBeenCalled();

    await user.type(nameEn, 'Expense flow v2');
    await user.click(screen.getByRole('button', { name: 'Publish template' }));

    expect(createConductorTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: { en: 'Expense flow v2', de: 'Spesenfluss' } }),
    );
  });

  it('shows the in-flight primary as verb + animated dots, never a spinner', async () => {
    const user = userEvent.setup();
    vi.mocked(createConductorTemplate).mockReturnValue(new Promise(() => {}));
    const { container } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Publish template' }));

    const busyButton = await screen.findByRole('button', { name: /Publishing/ });
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(busyButton.querySelector('.lume-busy-dots')).not.toBeNull();
    expect(container.querySelector('svg, .animate-spin')).toBeNull();
  });
});
