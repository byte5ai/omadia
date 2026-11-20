import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import type {
  AgentTemplatePrefillDto,
  AgentTemplateSummaryDto,
} from '../../../_lib/agentTemplates';
import { NewAgentDialog } from '../NewAgentDialog';

/**
 * #2049 — "New agent" in the Agent Builder (spec 2042 §5.2, §5.10, INV-8):
 *   - a template prefills name, slug and description; its suggested
 *     capabilities are offered unticked, the ungrantable ones disabled;
 *   - creating runs draft → identity → availability → exactly the ticked
 *     grants (through the broad-reach confirmation) → enable;
 *   - a failed step is named, the draft stays and can be deleted;
 *   - a blank agent has no identity step and no capability list;
 *   - a template of an archetype that is not installed cannot be created.
 */

const m = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  getAgentTemplatePrefill: vi.fn(),
  createOperatorAgent: vi.fn(),
  patchOperatorAgent: vi.fn(),
  replaceAgentPlugins: vi.fn(),
  deleteOperatorAgent: vi.fn(),
  saveAgentIdentity: vi.fn(),
  setAgentAvailability: vi.fn(),
}));

vi.mock('../../../_lib/agentTemplates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentTemplates')>()),
  listAgentTemplates: m.listAgentTemplates,
  getAgentTemplatePrefill: m.getAgentTemplatePrefill,
}));
vi.mock('../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agents')>()),
  createOperatorAgent: m.createOperatorAgent,
  patchOperatorAgent: m.patchOperatorAgent,
  replaceAgentPlugins: m.replaceAgentPlugins,
  deleteOperatorAgent: m.deleteOperatorAgent,
}));
vi.mock('../../../_lib/agentIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentIdentity')>()),
  saveAgentIdentity: m.saveAgentIdentity,
}));
vi.mock('../../../_lib/agentAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentAvailability')>()),
  setAgentAvailability: m.setAgentAvailability,
}));

const HANNA: AgentTemplateSummaryDto = {
  plugin_id: '@acme/hr',
  plugin_name: 'HR',
  plugin_version: '1.0.0',
  template_id: 'hr-assistant',
  archetype: 'standard',
  archetype_available: true,
  name: 'Hanna',
  short_description: 'HR colleague',
  language: 'de',
  suggested_capabilities: [
    { plugin_id: '@acme/odoo', installed: true, grantable: true },
    { plugin_id: '@acme/search', installed: true, grantable: true },
    { plugin_id: '@acme/missing', installed: false, grantable: false },
  ],
};
const MODERATOR: AgentTemplateSummaryDto = {
  ...HANNA,
  template_id: 'moderator',
  name: 'Mo',
  archetype: 'facilitator',
  archetype_available: false,
  suggested_capabilities: [],
};
const PREFILL: AgentTemplatePrefillDto = {
  template: HANNA,
  agent: { name: 'Hanna', description: 'HR colleague', archetype: 'standard' },
  identity: {
    display_name: 'Hanna',
    short_description: 'HR colleague',
    long_description: null,
    instructions: 'You are the HR colleague.',
    language: 'de',
    verbosity: 'brief',
    persona: { axes: { warmth: 80 } },
    quality: null,
  },
};

const broadReachRefusal = new ApiError(
  409,
  'PUT failed: 409',
  JSON.stringify({
    error: 'broad_reach_confirmation_required',
    slug: 'hanna',
    reach: {
      connected_systems: 2,
      systems: [{ name: 'Odoo' }, { name: 'Search' }],
    },
  }),
);

beforeEach(() => {
  m.listAgentTemplates.mockResolvedValue([HANNA, MODERATOR]);
  m.getAgentTemplatePrefill.mockResolvedValue(PREFILL);
  m.createOperatorAgent.mockImplementation(async (input: { slug: string }) => ({
    id: 'a1',
    slug: input.slug,
  }));
  m.saveAgentIdentity.mockResolvedValue({});
  m.setAgentAvailability.mockResolvedValue(undefined);
  m.replaceAgentPlugins.mockResolvedValue(undefined);
  m.patchOperatorAgent.mockResolvedValue({ ok: true });
  m.deleteOperatorAgent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function pickTemplate(key: string): Promise<void> {
  await screen.findByRole('option', { name: /Hanna/ });
  await userEvent.selectOptions(screen.getByTestId('new-agent-source'), key);
}

describe('NewAgentDialog', () => {
  it('prefills from a template and offers its capabilities unticked', async () => {
    renderWithIntl(<NewAgentDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickTemplate('@acme/hr::hr-assistant');

    await waitFor(() =>
      expect((screen.getByTestId('new-agent-name') as HTMLInputElement).value).toBe('Hanna'),
    );
    expect(m.getAgentTemplatePrefill).toHaveBeenCalledWith('@acme/hr', 'hr-assistant');
    expect((screen.getByTestId('new-agent-slug') as HTMLInputElement).value).toBe('hanna');
    const odoo = screen.getByTestId('new-agent-capability-@acme/odoo') as HTMLInputElement;
    expect(odoo.checked).toBe(false);
    expect(odoo.disabled).toBe(false);
    expect(
      (screen.getByTestId('new-agent-capability-@acme/missing') as HTMLInputElement).disabled,
    ).toBe(true);
    // A new agent reaches nobody until the operator says who.
    expect(screen.getByTestId('availability-nobody')).toBeTruthy();
  });

  it('creates the draft, writes identity and availability, grants exactly the ticked plugin after confirmation, enables', async () => {
    const onCreated = vi.fn();
    m.replaceAgentPlugins.mockRejectedValueOnce(broadReachRefusal);
    renderWithIntl(<NewAgentDialog onClose={vi.fn()} onCreated={onCreated} />);
    await pickTemplate('@acme/hr::hr-assistant');
    await screen.findByTestId('new-agent-capabilities');

    await userEvent.click(screen.getByTestId('new-agent-capability-@acme/odoo'));
    await userEvent.click(screen.getByTestId('availability-everyone'));
    await userEvent.click(screen.getByTestId('new-agent-enable'));
    await userEvent.click(screen.getByTestId('new-agent-create'));

    // The broad-reach refusal turns into the confirm dialog.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Grant access to everything' }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('hanna'));

    expect(m.createOperatorAgent).toHaveBeenCalledWith({
      slug: 'hanna',
      name: 'Hanna',
      description: 'HR colleague',
      archetype: 'standard',
      status: 'draft',
    });
    expect(m.saveAgentIdentity).toHaveBeenCalledWith('hanna', {
      ...PREFILL.identity,
      accent_color: null,
    });
    expect(m.setAgentAvailability).toHaveBeenCalledWith('hanna', {
      everyone: true,
      channels: null,
      principals: [],
    });
    expect(m.replaceAgentPlugins).toHaveBeenCalledTimes(2);
    expect(m.replaceAgentPlugins).toHaveBeenNthCalledWith(
      1,
      'hanna',
      [{ id: '@acme/odoo', enabled: true }],
      { confirmBroadReach: false },
    );
    expect(m.replaceAgentPlugins).toHaveBeenNthCalledWith(
      2,
      'hanna',
      [{ id: '@acme/odoo', enabled: true }],
      { confirmBroadReach: true },
    );
    expect(m.patchOperatorAgent).toHaveBeenCalledWith('hanna', {
      status: 'enabled',
    });
  });

  it('names a failed step, keeps the draft and can delete it', async () => {
    m.setAgentAvailability.mockRejectedValueOnce(new Error('availability route missing'));
    renderWithIntl(<NewAgentDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickTemplate('@acme/hr::hr-assistant');
    await screen.findByTestId('new-agent-capabilities');
    await userEvent.click(screen.getByTestId('new-agent-create'));

    const failed = await screen.findByTestId('new-agent-failed-step');
    expect(failed.textContent).toContain('availability');
    expect(failed.textContent).toContain('availability route missing');
    expect(screen.getByTestId('new-agent-draft-kept').textContent).toContain('hanna');
    expect(m.replaceAgentPlugins).not.toHaveBeenCalled();
    expect(m.patchOperatorAgent).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('new-agent-delete-draft'));
    await waitFor(() => expect(m.deleteOperatorAgent).toHaveBeenCalledWith('hanna'));
  });

  it('creates a blank agent as a draft without identity or grants', async () => {
    const onCreated = vi.fn();
    renderWithIntl(<NewAgentDialog onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.type(screen.getByTestId('new-agent-name'), 'Sales Desk');
    expect((screen.getByTestId('new-agent-slug') as HTMLInputElement).value).toBe('sales-desk');
    expect(screen.queryByTestId('new-agent-capabilities')).toBeNull();
    await userEvent.click(screen.getByTestId('new-agent-create'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('sales-desk'));
    expect(m.saveAgentIdentity).not.toHaveBeenCalled();
    expect(m.replaceAgentPlugins).not.toHaveBeenCalled();
    expect(m.patchOperatorAgent).not.toHaveBeenCalled();
    expect(m.setAgentAvailability).toHaveBeenCalledWith('sales-desk', {
      everyone: false,
      channels: null,
      principals: [],
    });
  });

  it('cannot create from a template whose archetype is not installed', async () => {
    renderWithIntl(<NewAgentDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await pickTemplate('@acme/hr::moderator');
    expect(await screen.findByTestId('new-agent-archetype-unavailable')).toBeTruthy();
    expect((screen.getByTestId('new-agent-create') as HTMLButtonElement).disabled).toBe(true);
  });
});
