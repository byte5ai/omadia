import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';

const { mockList, mockGet, mockPut, mockDelete, mockSwitches } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  mockSwitches: vi.fn(),
}));
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listOperatorAgents: mockList,
}));
vi.mock('../../../../_lib/consultation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/consultation')>()),
  getAgentConsultation: mockGet,
  putConsultationGrant: mockPut,
  deleteConsultationGrant: mockDelete,
  setConsultationSwitches: mockSwitches,
}));

import { ApiError } from '../../../../_lib/api';
import type { OperatorAgentDto } from '../../../../_lib/agents';
import type { AgentConsultationDto, ConsultationGrantDto } from '../../../../_lib/consultation';
import { AgentConsultation } from '../_components/AgentConsultation';

/**
 * Spec 2042 §5.4 (#2047) — the operator surface for consultation: two
 * switches, directed grants A → B, and who may consult this agent.
 */
function agent(slug: string, name: string, plugins: string[], extra: Partial<OperatorAgentDto> = {}): OperatorAgentDto {
  return {
    id: `id-${slug}`,
    slug,
    name,
    description: null,
    privacy_profile: 'default',
    status: 'enabled',
    created_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z',
    active: true,
    memory_scope: [],
    plugins: plugins.map((id) => ({ id, config: {}, enabled: true })),
    bindings: [],
    ...extra,
  };
}

const anna = agent('anna', 'Anna', ['crm', 'odoo']);
const ben = agent('ben', 'Ben', ['crm', 'hr']);
const fac = agent('fac', 'Facilitator', ['crm'], { archetype: 'facilitator' });
const off = agent('off', 'Off', ['crm'], { status: 'disabled' });

function grant(over: Partial<ConsultationGrantDto> = {}): ConsultationGrantDto {
  return {
    from: 'anna',
    to: 'ben',
    channelScope: null,
    allowedCapabilities: ['crm'],
    memoryAccess: 'none',
    disclosure: { context: 'existence' },
    maxCallsPerTurn: 2,
    maxCallsPerDay: 50,
    createdBy: 'op',
    createdAt: '2026-11-20T00:00:00Z',
    updatedBy: null,
    updatedAt: '2026-11-20T00:00:00Z',
    ...over,
  };
}

function state(over: Partial<AgentConsultationDto> = {}): AgentConsultationDto {
  return { slug: 'anna', consultable: false, mayConsult: true, consults: [], consultedBy: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ agents: [anna, ben, fac, off], fallback_agent_id: null });
  mockPut.mockResolvedValue({});
  mockDelete.mockResolvedValue(undefined);
  mockSwitches.mockResolvedValue({});
});

describe('<AgentConsultation />', () => {
  it('shows the switches, the grants this agent holds and who may consult it', async () => {
    mockGet.mockResolvedValue(
      state({ consults: [grant()], consultedBy: [grant({ from: 'ben', to: 'anna', allowedCapabilities: [] })] }),
    );
    renderWithIntl(<AgentConsultation agent={anna} />);

    expect(await screen.findByLabelText(/May consult other agents/)).toBeChecked();
    expect(screen.getByLabelText(/May be consulted/)).not.toBeChecked();
    expect(screen.getAllByText('Ben (ben)')).toHaveLength(2);
    expect(screen.getByText(/1 capability · memory: Not used · other conversations: Only that it knows/)).toBeTruthy();
    expect(screen.getByText(/no capabilities/)).toBeTruthy();
  });

  it('flips a switch through the API', async () => {
    mockGet.mockResolvedValue(state());
    renderWithIntl(<AgentConsultation agent={anna} />);
    fireEvent.click(await screen.findByLabelText(/May be consulted/));
    await waitFor(() => expect(mockSwitches).toHaveBeenCalledWith('anna', { consultable: true }));
  });

  it('offers only enabled standard agents, and only the plugins both agents hold', async () => {
    mockGet.mockResolvedValue(state());
    renderWithIntl(<AgentConsultation agent={anna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant an agent' }));

    const target = screen.getByLabelText('Agent to consult');
    const options = Array.from((target as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'ben']);

    fireEvent.change(target, { target: { value: 'ben' } });
    expect(screen.getByLabelText('crm')).toBeTruthy();
    expect(screen.queryByLabelText('odoo')).toBeNull();
    expect(screen.queryByLabelText('hr')).toBeNull();

    fireEvent.click(screen.getByLabelText('crm'));
    fireEvent.change(screen.getByLabelText('From other conversations'), { target: { value: 'existence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save grant' }));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('anna', 'ben', {
        allowedCapabilities: ['crm'],
        memoryAccess: 'none',
        disclosure: { context: 'existence' },
        maxCallsPerTurn: 2,
        maxCallsPerDay: 50,
      }),
    );
  });

  it('revokes a grant', async () => {
    mockGet.mockResolvedValue(state({ consults: [grant()] }));
    renderWithIntl(<AgentConsultation agent={anna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('anna', 'ben'));
  });

  it('names a known server refusal in the catalogue copy (German)', async () => {
    mockGet.mockResolvedValue(state());
    mockSwitches.mockRejectedValue(new ApiError(409, 'PUT failed: 409', JSON.stringify({ error: 'archetype_omits' })));
    renderWithIntl(<AgentConsultation agent={anna} />, { locale: 'de' });
    fireEvent.click(await screen.findByLabelText(/Darf befragt werden/));
    expect(await screen.findByRole('alert')).toHaveTextContent('Facilitatoren befragen niemanden');
  });
});
