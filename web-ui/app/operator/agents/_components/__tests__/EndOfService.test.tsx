import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeletedAgentDto, EndOfServiceDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { DeletedAgentsSection, EndOfServiceNotice } from '../EndOfService';

/**
 * #2088 — the operator sees what ended with an agent that was disabled or
 * deleted, and removes a deleted agent for good only by an explicit step.
 */
const { mockList, mockPurge } = vi.hoisted(() => ({ mockList: vi.fn(), mockPurge: vi.fn() }));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listDeletedAgents: mockList,
  purgeDeletedAgent: mockPurge,
}));

const REPORT: EndOfServiceDto = {
  reason: 'agent_deleted',
  process_outcome: 'ended',
  processes: [
    {
      process_id: 'fac-7',
      channel_type: 'teams',
      conversation_id: '19:offsite@thread.v2',
      outcome: 'aborted',
      report_posted: true,
      detail: 'vote open, 2 of 4 ballots',
    },
  ],
  subscriptions_ended: [
    { channel_type: 'teams', conversation_id: '19:offsite@thread.v2' },
    { channel_type: 'teams', conversation_id: '19:other@thread.v2' },
  ],
  system_notices_owed: 2,
};

const tombstone = (over: Partial<DeletedAgentDto> = {}): DeletedAgentDto => ({
  id: 'id-mara',
  slug: 'mara',
  name: 'Mara',
  archetype: 'facilitator',
  deleted_at: '2026-11-19T10:00:00.000Z',
  deleted_by: 'marcel@example.test',
  purgeable_from: '2026-12-19T10:00:00.000Z',
  purgeable_without_confirmation: false,
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('<EndOfServiceNotice />', () => {
  it('says which processes and conversations ended, and that omadia itself told nobody yet', async () => {
    const onDismiss = vi.fn();
    renderWithIntl(<EndOfServiceNotice result={{ agentName: 'Mara', change: 'deleted', report: REPORT }} onDismiss={onDismiss} />);
    const notice = screen.getByTestId('end-of-service-notice').textContent ?? '';
    expect(notice).toContain('“Mara” is deleted. Its record is kept under “Deleted agents”');
    expect(notice).toContain('One running process was ended:');
    expect(notice).toContain('teams, conversation 19:offsite@thread.v2: ended by its archetype plugin, the conversation was told');
    expect(notice).toContain('vote open, 2 of 4 ballots');
    expect(notice).toContain('It no longer receives the messages of 2 conversations.');
    expect(notice).toContain('2 conversations were not told by omadia itself: system notices are not available yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a plugin that did not end the processes is said plainly, with what omadia did instead', () => {
    renderWithIntl(
      <EndOfServiceNotice
        result={{
          agentName: 'Mara',
          change: 'disabled',
          report: { ...REPORT, reason: 'agent_disabled', process_outcome: 'failed', process_detail: 'no answer within 20000 ms', processes: [], system_notices_owed: 0 },
        }}
        onDismiss={() => undefined}
      />,
    );
    const notice = screen.getByTestId('end-of-service-notice').textContent ?? '';
    expect(notice).toContain('“Mara” is disabled.');
    expect(notice).toContain('did not end the agent\'s processes (no answer within 20000 ms)');
    expect(notice).toContain('omadia stopped delivering messages for the agent');
    expect(notice).not.toContain('system notices');
  });
});

describe('<DeletedAgentsSection />', () => {
  it('stays away when nothing is deleted', async () => {
    mockList.mockResolvedValue({ retention_days: 30, agents: [] });
    renderWithIntl(<DeletedAgentsSection refreshKey={0} />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByTestId('deleted-agents-section')).toBeNull();
  });

  it('inside the retention period the slug must be typed; a wrong one removes nothing', async () => {
    mockList.mockResolvedValue({ retention_days: 30, agents: [tombstone()] });
    mockPurge.mockResolvedValue({ ok: true });
    const prompt = vi.fn().mockReturnValueOnce('hr').mockReturnValueOnce('mara');
    vi.stubGlobal('prompt', prompt);
    renderWithIntl(<DeletedAgentsSection refreshKey={0} />);
    const row = await screen.findByTestId('deleted-agent-mara');
    expect(row.textContent).toContain('Mara (mara) · deleted');
    expect(row.textContent).toContain('by marcel@example.test');
    expect(row.textContent).toContain('can be removed without typing the slug from');

    await userEvent.click(screen.getByRole('button', { name: 'Remove for good' }));
    expect(prompt.mock.calls[0]?.[0]).toContain('deleted less than 30 days ago. Type its slug “mara”');
    expect(mockPurge).not.toHaveBeenCalled();
    expect(screen.getByText('That is not the slug. Nothing was removed.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove for good' }));
    await waitFor(() => expect(mockPurge).toHaveBeenCalledWith('id-mara', 'mara'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('after the retention period a plain confirmation is enough', async () => {
    mockList.mockResolvedValue({ retention_days: 30, agents: [tombstone({ purgeable_without_confirmation: true, deleted_by: null })] });
    mockPurge.mockResolvedValue({ ok: true });
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    renderWithIntl(<DeletedAgentsSection refreshKey={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove for good' }));
    expect(confirm.mock.calls[0]?.[0]).toContain('Remove “mara” for good? Its identity, grants, bindings and schedules are deleted with it.');
    await waitFor(() => expect(mockPurge).toHaveBeenCalledWith('id-mara', undefined));
  });
});
