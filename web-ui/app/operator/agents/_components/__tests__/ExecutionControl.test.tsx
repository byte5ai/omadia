import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { ExecutionOverviewDto, ExecutionScopeDto, KillSwitchDto, RunningDiscussionDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { ExecutionControlSection } from '../ExecutionControl';

/**
 * #2090 — the operator sees what archetype plugins are currently allowed to
 * do, and stops it for the instance, one agent or one process.
 */
const { mockOverview, mockSet, mockClear, mockStopDiscussion, mockRelease } = vi.hoisted(() => ({
  mockRelease: vi.fn(),
  mockStopDiscussion: vi.fn(),
  mockOverview: vi.fn(),
  mockSet: vi.fn(),
  mockClear: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getExecutionOverview: mockOverview,
  setKillSwitch: mockSet,
  clearKillSwitch: mockClear,
  stopDiscussion: mockStopDiscussion,
  releaseReservation: mockRelease,
}));

const scope = (over: Partial<ExecutionScopeDto> = {}): ExecutionScopeDto => ({
  id: 'scope-1',
  agent_slug: 'mara',
  plugin_id: '@omadia/agent-facilitator',
  process_id: 'fac-7',
  kind: 'active',
  event_id: null,
  deadline: '2026-12-01T10:00:00.000Z',
  absolute_limit: '2027-11-19T10:00:00.000Z',
  deadline_wait: false,
  budget: { actions: 100, model_calls: 40 },
  used: { actions: 12, model_calls: 5 },
  conversations: 1,
  people: 4,
  opened_at: '2026-11-19T10:00:00.000Z',
  stopped: false,
  ...over,
});

const killSwitch = (over: Partial<KillSwitchDto> = {}): KillSwitchDto => ({
  id: 'ks-1',
  level: 'instance',
  agent_slug: null,
  process_id: null,
  reason: '',
  set_by: 'op@example.test',
  set_at: '2026-11-19T12:00:00.000Z',
  ...over,
});

const discussion = (over: Partial<RunningDiscussionDto> = {}): RunningDiscussionDto => ({
  workflow_id: 'wf-1',
  slug: 'eph-discussion-ab12cd34',
  opened_by: 'hr',
  participants: ['hr', 'accounting'],
  topic: 'Budget 2027',
  conversation: { channel_type: 'teams', conversation_id: '19:meeting-abc@thread.v2' },
  status: 'running',
  started_at: '2026-11-19T07:00:00.000Z',
  stop_requested_at: null,
  expires_at: '2026-11-20T07:00:00.000Z',
  incomplete: false,
  ...over,
});

const overview = (data: Partial<ExecutionOverviewDto>): ExecutionOverviewDto => ({
  kill_switches: [],
  scopes: [],
  discussions: [],
  discussions_failed: false,
  ...data,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<ExecutionControlSection />', () => {
  it('stays away while nothing runs and nothing is stopped, and on a middleware without the endpoint', async () => {
    mockOverview.mockResolvedValueOnce(overview({}));
    const first = renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    await waitFor(() => expect(mockOverview).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('execution-control-section')).toBeNull();
    first.unmount();

    for (const status of [404, 503]) {
      mockOverview.mockRejectedValueOnce(new ApiError(status, 'gone'));
      const view = renderWithIntl(<ExecutionControlSection refreshKey={0} />);
      await waitFor(() => expect(mockOverview).toHaveBeenCalled());
      expect(screen.queryByTestId('execution-control-section')).toBeNull();
      view.unmount();
    }
  });

  it('shows each running process with its deadline and what it used', async () => {
    mockOverview.mockResolvedValue(overview({ scopes: [scope(), scope({ id: 'scope-2', kind: 'closing', process_id: 'fac-3', deadline_wait: false })] }));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('mara: active (process fac-7)')).toBeInTheDocument();
    expect(screen.getByText('mara: closing (process fac-3)')).toBeInTheDocument();
    expect(screen.getAllByText(/12 of 100 actions and 5 of 40 model calls used/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop everything' })).toBeInTheDocument();
  });

  it('stops one process, one agent, or everything, and reloads', async () => {
    mockOverview.mockResolvedValue(overview({ scopes: [scope()] }));
    mockSet.mockResolvedValue({ kill_switch: killSwitch() });
    const user = userEvent.setup();
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    await user.click(await screen.findByRole('button', { name: 'Stop this process' }));
    expect(mockSet).toHaveBeenLastCalledWith({ level: 'process', agent_slug: 'mara', process_id: 'fac-7' });
    await user.click(await screen.findByRole('button', { name: 'Stop this agent' }));
    expect(mockSet).toHaveBeenLastCalledWith({ level: 'agent', agent_slug: 'mara' });
    await user.click(await screen.findByRole('button', { name: 'Stop everything' }));
    expect(mockSet).toHaveBeenLastCalledWith({ level: 'instance' });
    await waitFor(() => expect(mockOverview).toHaveBeenCalledTimes(4));
  });

  it('a stopped process is marked, offers no further stop, and the switch can be resumed', async () => {
    mockOverview.mockResolvedValue(
      overview({
        scopes: [scope({ stopped: true })],
        kill_switches: [killSwitch({ level: 'process', agent_slug: 'mara', process_id: 'fac-7', reason: 'runaway reminders' })],
      }),
    );
    mockClear.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('stopped')).toBeInTheDocument();
    expect(screen.getByText(/Process fac-7 of agent mara is stopped \(by op@example.test/)).toBeInTheDocument();
    expect(screen.getByText('runaway reminders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop this process' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mockClear).toHaveBeenCalledWith('ks-1');
  });

  it('with everything stopped there is no second "stop everything"; with no process left it says so', async () => {
    mockOverview.mockResolvedValue(overview({ kill_switches: [killSwitch()] }));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText(/Everything is stopped \(by op@example.test/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop everything' })).toBeNull();
    expect(screen.getByText('No process is running.')).toBeInTheDocument();
  });

  it('says so when a stop did not work, and when the list cannot be loaded', async () => {
    mockOverview.mockResolvedValue(overview({ scopes: [scope()] }));
    mockSet.mockRejectedValue(new ApiError(500, 'boom'));
    const user = userEvent.setup();
    const view = renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    await user.click(await screen.findByRole('button', { name: 'Stop this process' }));
    expect(await screen.findByText('That did not work. Nothing was changed; try again.')).toBeInTheDocument();
    view.unmount();

    mockOverview.mockReset();
    mockOverview.mockRejectedValue(new ApiError(500, 'boom'));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('The running processes could not be loaded.')).toBeInTheDocument();
  });

  it('lists a running agent discussion although no process runs, with who opened it and who takes part', async () => {
    mockOverview.mockResolvedValue(overview({ discussions: [discussion()] }));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('Running agent discussions')).toBeInTheDocument();
    expect(screen.getByText('Budget 2027')).toBeInTheDocument();
    expect(screen.getByText(/opened by hr · taking part: hr, accounting · started .* · ends by itself /)).toBeInTheDocument();
    expect(screen.getByText('teams conversation 19:meeting-abc@thread.v2')).toBeInTheDocument();
  });

  it('ends a discussion only after the operator confirmed in the row, and reloads', async () => {
    mockOverview.mockResolvedValue(overview({ discussions: [discussion()] }));
    mockStopDiscussion.mockResolvedValue({ ok: true, cancelled_runs: 1 });
    const user = userEvent.setup();
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);

    await user.click(await screen.findByRole('button', { name: 'End discussion' }));
    expect(screen.getByText('End this discussion for good?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it running' }));
    expect(mockStopDiscussion).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'End discussion' }));
    await user.click(screen.getByRole('button', { name: 'Yes, end it' }));
    expect(mockStopDiscussion).toHaveBeenCalledWith('wf-1');
    await waitFor(() => expect(mockOverview).toHaveBeenCalledTimes(2));
  });

  it('says so when a discussion could not be stopped', async () => {
    mockOverview.mockResolvedValue(overview({ discussions: [discussion()] }));
    mockStopDiscussion.mockRejectedValue(new ApiError(502, 'cancel failed'));
    const user = userEvent.setup();
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    await user.click(await screen.findByRole('button', { name: 'End discussion' }));
    await user.click(screen.getByRole('button', { name: 'Yes, end it' }));
    expect(await screen.findByText('That did not work. Nothing was changed; try again.')).toBeInTheDocument();
    expect(screen.getByText('Budget 2027')).toBeInTheDocument();
  });

  it('names a run without a topic by its slug, and marks a requested stop and missing details', async () => {
    mockOverview.mockResolvedValue(
      overview({
        discussions: [
          discussion({ topic: null, participants: [], conversation: null, stop_requested_at: '2026-11-19T08:00:00.000Z', incomplete: true }),
        ],
      }),
    );
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('No topic recorded (eph-discussion-ab12cd34)')).toBeInTheDocument();
    expect(screen.getByText('stop requested')).toBeInTheDocument();
    expect(screen.getByText('Some details of this discussion could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/taking part/)).toBeNull();
  });

  it('shows that the discussions could not be loaded instead of showing none', async () => {
    mockOverview.mockResolvedValue(overview({ discussions_failed: true }));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('The running agent discussions could not be loaded.')).toBeInTheDocument();
  });

  it('lists a held conversation although nothing runs, and releases it only after the operator confirmed (D34)', async () => {
    mockOverview.mockResolvedValue(
      overview({
        reservations: [
          {
            id: 'res-1',
            channel_type: 'teams',
            conversation_id: '19:stale@thread.v2',
            holder_kind: 'agent_discussion',
            agent_slug: null,
            plugin_id: null,
            process_id: 'discussion:17',
            role: 'home',
            reserved_at: '2026-11-19T06:00:00.000Z',
          },
          {
            id: 'res-2',
            channel_type: 'teams',
            conversation_id: '19:offsite@thread.v2',
            holder_kind: 'archetype_process',
            agent_slug: 'mara',
            plugin_id: '@omadia/agent-facilitator',
            process_id: 'fac-7',
            role: 'home',
            reserved_at: '2026-11-19T06:00:00.000Z',
          },
        ],
      }),
    );
    mockRelease.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    expect(await screen.findByText('Held conversations')).toBeInTheDocument();
    expect(screen.getByText(/held by an agent discussion since/)).toBeInTheDocument();
    expect(screen.getByText(/held by mara, process fac-7, since/)).toBeInTheDocument();

    const row = screen.getByTestId('held-reservation-res-1');
    await user.click(within(row).getByRole('button', { name: 'Release' }));
    await user.click(within(row).getByRole('button', { name: 'Keep it held' }));
    expect(mockRelease).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Release' }));
    await user.click(within(row).getByRole('button', { name: 'Yes, release' }));
    expect(mockRelease).toHaveBeenCalledWith('res-1');
    await waitFor(() => expect(mockOverview).toHaveBeenCalledTimes(2));
  });

  it('shows no held conversations on a middleware that does not list them', async () => {
    mockOverview.mockResolvedValue(overview({ scopes: [scope()] }));
    renderWithIntl(<ExecutionControlSection refreshKey={0} />);
    await screen.findByText('mara: active (process fac-7)');
    expect(screen.queryByTestId('held-reservations')).toBeNull();
  });
});
