import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { AgentAvailabilitySection } from '../panels/AgentAvailabilitySection';
import { AgentTemplateExportSection } from '../panels/AgentTemplateExportSection';

/**
 * #2049 — the agent node of the Agent Builder inspector shows and saves who
 * may reach the agent, and exports the agent as an agent template.
 */

const m = vi.hoisted(() => ({
  listOperatorAgents: vi.fn(),
  setAgentAvailability: vi.fn(),
  getAgentTemplateExport: vi.fn(),
}));

vi.mock('../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agents')>()),
  listOperatorAgents: m.listOperatorAgents,
}));
vi.mock('../../../_lib/agentAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentAvailability')>()),
  setAgentAvailability: m.setAgentAvailability,
}));
vi.mock('../../../_lib/agentTemplates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentTemplates')>()),
  getAgentTemplateExport: m.getAgentTemplateExport,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentAvailabilitySection', () => {
  it('loads the agent availability and saves an edit', async () => {
    m.listOperatorAgents.mockResolvedValue({
      agents: [
        {
          slug: 'sales',
          availability: {
            everyone: false,
            channels: ['teams'],
            principals: ['role:sales'],
          },
        },
      ],
      fallback_agent_id: null,
    });
    m.setAgentAvailability.mockResolvedValue(undefined);
    renderWithIntl(<AgentAvailabilitySection slug="sales" />);

    const everyone = (await screen.findByTestId('availability-everyone')) as HTMLInputElement;
    expect(everyone.checked).toBe(false);
    expect((screen.getByTestId('availability-channels') as HTMLInputElement).value).toBe('teams');
    await userEvent.click(everyone);
    await userEvent.click(screen.getByRole('button', { name: 'Save availability' }));

    await waitFor(() =>
      expect(m.setAgentAvailability).toHaveBeenCalledWith('sales', {
        everyone: true,
        channels: ['teams'],
        principals: ['role:sales'],
      }),
    );
    expect(await screen.findByText('Availability saved.')).toBeTruthy();
  });

  it('says so when the middleware does not report availability', async () => {
    m.listOperatorAgents.mockResolvedValue({
      agents: [{ slug: 'sales' }],
      fallback_agent_id: null,
    });
    renderWithIntl(<AgentAvailabilitySection slug="sales" />);
    expect(await screen.findByTestId('builder-availability-missing')).toBeTruthy();
    expect(screen.queryByTestId('agent-availability-editor')).toBeNull();
  });

  it('shows a failed save', async () => {
    m.listOperatorAgents.mockResolvedValue({
      agents: [
        {
          slug: 'sales',
          availability: { everyone: true, channels: null, principals: [] },
        },
      ],
      fallback_agent_id: null,
    });
    m.setAgentAvailability.mockRejectedValue(new Error('PUT failed: 404'));
    renderWithIntl(<AgentAvailabilitySection slug="sales" />);
    await screen.findByTestId('availability-everyone');
    await userEvent.click(screen.getByRole('button', { name: 'Save availability' }));
    expect((await screen.findByRole('alert')).textContent).toContain('PUT failed: 404');
  });
});

describe('AgentTemplateExportSection', () => {
  it('links the YAML download and shows the JSON entry', async () => {
    m.getAgentTemplateExport.mockResolvedValue({
      id: 'sales',
      archetype: 'standard',
      name: 'Sales',
      capabilities: ['@acme/odoo'],
    });
    renderWithIntl(<AgentTemplateExportSection slug="sales" />);

    expect(screen.getByTestId('builder-export-template-download').getAttribute('href')).toBe(
      '/bot-api/v1/operator/agents/sales/template?format=yaml',
    );
    await userEvent.click(screen.getByTestId('builder-export-template-json'));
    const preview = await screen.findByTestId('builder-export-template-preview');
    expect(JSON.parse(preview.textContent ?? '')).toEqual({
      agent_templates: [
        {
          id: 'sales',
          archetype: 'standard',
          name: 'Sales',
          capabilities: ['@acme/odoo'],
        },
      ],
    });
    expect(m.getAgentTemplateExport).toHaveBeenCalledWith('sales');
  });

  it('shows a refused export', async () => {
    m.getAgentTemplateExport.mockRejectedValue(new Error('template_export_invalid'));
    renderWithIntl(<AgentTemplateExportSection slug="sales" />);
    await userEvent.click(screen.getByTestId('builder-export-template-json'));
    expect((await screen.findByRole('alert')).textContent).toContain('template_export_invalid');
  });
});
