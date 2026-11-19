import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { ExecutionOverviewDto, ExecutionScopeDto, KillSwitchDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { ExecutionControlSection } from '../ExecutionControl';

/**
 * #2090 — the operator sees what archetype plugins are currently allowed to
 * do, and stops it for the instance, one agent or one process.
 */
const { mockOverview, mockSet, mockClear } = vi.hoisted(() => ({
  mockOverview: vi.fn(),
  mockSet: vi.fn(),
  mockClear: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getExecutionOverview: mockOverview,
  setKillSwitch: mockSet,
  clearKillSwitch: mockClear,
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

const overview = (data: Partial<ExecutionOverviewDto>): ExecutionOverviewDto => ({ kill_switches: [], scopes: [], ...data });

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
});
