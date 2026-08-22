import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelConductorRun, getConductorRun, listConductorRuns, type ConductorRun } from '@/app/_lib/api';
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

function run(overrides: Partial<ConductorRun>): ConductorRun {
  return {
    id: 'run-1',
    status: 'waiting',
    triggerKind: 'manual',
    startedAt: '2026-08-22T07:00:00.000Z',
    endedAt: null,
    currentStepId: null,
    isDryRun: false,
    cancelRequestedAt: null,
    ...overrides,
  } as ConductorRun;
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
