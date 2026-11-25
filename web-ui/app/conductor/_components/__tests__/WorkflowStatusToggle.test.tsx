import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, setConductorWorkflowStatus } from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { WorkflowStatusToggle } from '../WorkflowStatusToggle';

// Partial mock: only the network call is stubbed — ApiError stays real (same
// pattern as ConductorRunHistory.test).
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    setConductorWorkflowStatus: vi.fn(),
  };
});

// #1711 — a template instance starts `disabled` and the backend status route had
// no caller in the UI, so the operator had to hand-write an API call to get out.
describe('WorkflowStatusToggle (#1711)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setConductorWorkflowStatus).mockResolvedValue(undefined);
  });

  it('enables a disabled workflow and reports the change to the list', async () => {
    const onChanged = vi.fn();
    renderWithIntl(
      <WorkflowStatusToggle slug="onb-probe" status="disabled" onChanged={onChanged} onError={() => undefined} />,
    );

    // The label names the TARGET state: a disabled row offers "Activate".
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => {
      expect(setConductorWorkflowStatus).toHaveBeenCalledWith('onb-probe', 'enabled');
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('disables an enabled workflow', async () => {
    renderWithIntl(
      <WorkflowStatusToggle slug="onb-probe" status="enabled" onChanged={() => undefined} onError={() => undefined} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => {
      expect(setConductorWorkflowStatus).toHaveBeenCalledWith('onb-probe', 'disabled');
    });
  });

  it('reports a failure as catalog copy, never the raw ApiError text', async () => {
    vi.mocked(setConductorWorkflowStatus).mockRejectedValue(
      new ApiError(500, 'POST /v1/operator/conductors/onb-probe/status failed: 500', '{"code":"conductor.status_failed"}'),
    );
    const onError = vi.fn();
    const onChanged = vi.fn();
    renderWithIntl(
      <WorkflowStatusToggle slug="onb-probe" status="disabled" onChanged={onChanged} onError={onError} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith('The workflow status could not be changed');
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('is inert while another row mutation (delete) is in flight', async () => {
    renderWithIntl(
      <WorkflowStatusToggle
        slug="onb-probe"
        status="disabled"
        disabled
        onChanged={() => undefined}
        onError={() => undefined}
      />,
    );

    const button = screen.getByRole('button', { name: 'Activate' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(setConductorWorkflowStatus).not.toHaveBeenCalled();
  });

  it('sends one status change per intent, not one per click', async () => {
    // The flip is a toggle: a double-fired click would set 'enabled' and then
    // 'disabled' again, leaving the workflow exactly as unusable as before.
    let release: (() => void) | undefined;
    vi.mocked(setConductorWorkflowStatus).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    renderWithIntl(
      <WorkflowStatusToggle slug="onb-probe" status="disabled" onChanged={() => undefined} onError={() => undefined} />,
    );

    const button = screen.getByRole('button', { name: 'Activate' });
    await userEvent.click(button);
    await userEvent.click(button, { pointerEventsCheck: 0 });

    expect(setConductorWorkflowStatus).toHaveBeenCalledTimes(1);
    release?.();
  });
});
