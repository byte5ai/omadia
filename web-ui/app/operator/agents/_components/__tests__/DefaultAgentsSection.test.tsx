import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { DefaultAgentEntryDto, OperatorAgentDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { DefaultAgentsSection, toUserPrincipal } from '../DefaultAgentsSection';

/**
 * #2055 / #2057 — the default-agent table: rows per user and channel type,
 * `off`, the instance row that is set and never removed, and the refusals the
 * server names, each in its own sentence.
 */

const { mockList, mockPut, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listDefaultAgentEntries: mockList,
  putDefaultAgentEntry: mockPut,
  deleteDefaultAgentEntry: mockDelete,
}));

function entry(over: Partial<DefaultAgentEntryDto> & { id: string }): DefaultAgentEntryDto {
  return {
    principal: null,
    channel_type: null,
    off: false,
    agent_slug: 'mira',
    agent_name: 'Mira',
    agent_status: 'enabled',
    updated_by: null,
    updated_at: '2026-11-20T00:00:00.000Z',
    ...over,
  };
}

const agents = [
  { slug: 'mira', name: 'Mira', status: 'enabled' },
  { slug: 'tom', name: 'Tom', status: 'enabled' },
  { slug: 'old', name: 'Old', status: 'disabled' },
] as unknown as OperatorAgentDto[];

function renderSection(): void {
  renderWithIntl(<DefaultAgentsSection agents={agents} channelTypes={['teams', 'slack']} />);
}

describe('toUserPrincipal', () => {
  it('names a user by e-mail or by principal, and blank as everyone', () => {
    expect(toUserPrincipal(' anna@example.com ')).toBe('user:anna@example.com');
    expect(toUserPrincipal('user:anna@example.com')).toBe('user:anna@example.com');
    expect(toUserPrincipal('User:anna@example.com')).toBe('user:anna@example.com');
    expect(toUserPrincipal('  ')).toBeNull();
  });
});

describe('<DefaultAgentsSection />', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockPut.mockReset().mockResolvedValue(undefined);
    mockDelete.mockReset().mockResolvedValue(undefined);
  });

  it('lists the most specific row first and shows off and a deleted agent honestly', async () => {
    mockList.mockResolvedValue([
      entry({ id: 'inst' }),
      entry({ id: 'u', principal: 'user:anna@example.com', channel_type: 'teams', agent_slug: 'tom', agent_name: 'Tom' }),
      entry({ id: 'c', channel_type: 'slack', off: true, agent_slug: null, agent_name: null, agent_status: null }),
      entry({ id: 'd', principal: 'user:ben@example.com', agent_status: 'deleted' }),
    ]);
    renderSection();
    const rows = await screen.findAllByTestId(/^default-entry-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'default-entry-u',
      'default-entry-d',
      'default-entry-c',
      'default-entry-inst',
    ]);
    expect(within(rows[0]!).getByText('anna@example.com')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('deleted')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/off/)).toBeInTheDocument();
  });

  it('never offers to remove the instance row', async () => {
    mockList.mockResolvedValue([entry({ id: 'inst' }), entry({ id: 'c', channel_type: 'slack' })]);
    renderSection();
    const inst = await screen.findByTestId('default-entry-inst');
    expect(within(inst).queryByRole('button')).toBeNull();
    const row = screen.getByTestId('default-entry-c');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove the row for Everyone in slack' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('c'));
  });

  it('saves a row for a user in a channel with an agent, and one with off', async () => {
    mockList.mockResolvedValue([entry({ id: 'inst' })]);
    renderSection();
    await screen.findByTestId('default-entry-inst');
    await userEvent.type(screen.getByLabelText('User (e-mail)'), 'anna@example.com');
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'teams');
    await userEvent.selectOptions(screen.getByLabelText('Agent'), 'tom');
    await userEvent.click(screen.getByRole('button', { name: 'Save row' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({
        principal: 'user:anna@example.com',
        channelType: 'teams',
        agentSlug: 'tom',
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Agent'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save row' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenLastCalledWith({
        principal: 'user:anna@example.com',
        channelType: 'teams',
        agentSlug: null,
      }),
    );
  });

  it('only offers enabled agents', async () => {
    mockList.mockResolvedValue([entry({ id: 'inst' })]);
    renderSection();
    await screen.findByTestId('default-entry-inst');
    const options = within(screen.getByLabelText('Agent')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['off (system notice)', 'Mira', 'Tom']);
  });

  it('says why the server refused an agent, in a sentence', async () => {
    mockList.mockResolvedValue([entry({ id: 'inst' })]);
    mockPut.mockRejectedValue(
      new ApiError(409, 'PUT failed: 409', JSON.stringify({ error: 'agent_not_available_to_everyone', slug: 'tom' })),
    );
    renderSection();
    await screen.findByTestId('default-entry-inst');
    await userEvent.click(screen.getByRole('button', { name: 'Save row' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not available to everyone');
  });

  it('says so when the table cannot be loaded', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });
});
