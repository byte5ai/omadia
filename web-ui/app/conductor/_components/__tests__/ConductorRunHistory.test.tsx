import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelConductorRun,
  getConductorRun,
  listConductorRuns,
  type ConductorRunListEntry,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { ConductorRunHistory } from '../ConductorRunTrace';

// Partial mock: only the network layer is stubbed — ApiError and the wire
// types stay real (same pattern as TemplateInstantiateForm.test).
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    listConductorRuns: vi.fn(),
    getConductorRun: vi.fn(),
    cancelConductorRun: vi.fn(),
  };
});

function run(overrides: Partial<ConductorRunListEntry>): ConductorRunListEntry {
  return {
    id: 'run-1',
    status: 'waiting',
    triggerKind: 'manual',
    startedAt: '2026-08-22T07:00:00.000Z',
    endedAt: null,
    currentStepId: null,
    isDryRun: false,
    cancelRequestedAt: null,
    workflowVersion: 1,
    ...overrides,
  } as ConductorRunListEntry;
}

// #330 field report — the delete guard demands cancelling active runs, so the
// cancel affordance must be reachable from the run LIST, not only inside an
// opened trace.
describe('ConductorRunHistory — run-list cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConductorRuns).mockResolvedValue({
      runs: [run({ id: 'run-active', status: 'waiting' }), run({ id: 'run-done', status: 'completed' })],
    });
    vi.mocked(cancelConductorRun).mockResolvedValue(undefined as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('offers cancel on active rows only, and cancels straight from the list', async () => {
    renderWithIntl(<ConductorRunHistory slug="test-teams" onClose={() => undefined} />);

    // Exactly ONE cancel button: the waiting run's row; the succeeded run has none.
    const cancelButtons = await screen.findAllByRole('button', { name: 'Cancel run' });
    expect(cancelButtons).toHaveLength(1);

    await userEvent.click(cancelButtons[0]!);
    await waitFor(() => {
      expect(cancelConductorRun).toHaveBeenCalledWith('test-teams', 'run-active');
    });
    // List refresh after the cancel — the guard-blocked delete becomes possible.
    expect(listConductorRuns).toHaveBeenCalledTimes(2);
    // No trace was open for this run, so the row-level cancel must not fetch one.
    expect(getConductorRun).not.toHaveBeenCalled();
  });

  it('a declined confirm dialog cancels nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithIntl(<ConductorRunHistory slug="test-teams" onClose={() => undefined} />);
    const cancelButtons = await screen.findAllByRole('button', { name: 'Cancel run' });
    await userEvent.click(cancelButtons[0]!);
    expect(cancelConductorRun).not.toHaveBeenCalled();
  });
});

// #1710 — the history spans every version of the workflow: re-publishing used
// to empty it, hiding the cancel button of a run still waiting on an older
// version while DELETE refused the workflow with `has_active_runs`.
describe('ConductorRunHistory — runs across workflow versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cancelConductorRun).mockResolvedValue(undefined as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('names each row’s version and keeps the older version’s waiting run cancellable', async () => {
    vi.mocked(listConductorRuns).mockResolvedValue({
      runs: [
        run({ id: 'run-old', status: 'waiting', workflowVersion: 1 }),
        run({ id: 'run-new', status: 'completed', workflowVersion: 2 }),
      ],
    });
    renderWithIntl(<ConductorRunHistory slug="p09-rolle" onClose={() => undefined} />);

    expect(await screen.findByTitle('Workflow version 1')).toHaveTextContent('v1');
    expect(screen.getByTitle('Workflow version 2')).toHaveTextContent('v2');

    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel run' });
    expect(cancelButtons).toHaveLength(1);
    await userEvent.click(cancelButtons[0]!);
    await waitFor(() => {
      expect(cancelConductorRun).toHaveBeenCalledWith('p09-rolle', 'run-old');
    });
  });

  it('names the version inside the opened run too — the detail route serves none', async () => {
    vi.mocked(listConductorRuns).mockResolvedValue({
      runs: [run({ id: 'run-old', status: 'waiting', workflowVersion: 1 })],
    });
    vi.mocked(getConductorRun).mockResolvedValue({
      run: run({ id: 'run-old', status: 'waiting' }),
      steps: [],
    });
    renderWithIntl(<ConductorRunHistory slug="p09-rolle" onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: /manual/ }));

    expect(await screen.findByRole('button', { name: /Back to runs/ })).toBeTruthy();
    expect(screen.getByTitle('Workflow version 1')).toHaveTextContent('v1');
  });

  it('renders a row served without a version (middleware older than #1710) without a badge', async () => {
    vi.mocked(listConductorRuns).mockResolvedValue({
      runs: [run({ id: 'run-old', status: 'waiting', workflowVersion: undefined })],
    });
    renderWithIntl(<ConductorRunHistory slug="p09-rolle" onClose={() => undefined} />);

    expect(await screen.findAllByRole('button', { name: 'Cancel run' })).toHaveLength(1);
    expect(screen.queryByTitle(/Workflow version/)).toBeNull();
  });
});
