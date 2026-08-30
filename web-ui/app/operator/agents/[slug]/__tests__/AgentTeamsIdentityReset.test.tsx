import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { ResetAgentTeamsIdentityResponse } from '../../../../_lib/agents';
import { AgentTeamsIdentityReset } from '../_components/AgentTeamsIdentityReset';

/**
 * The destructive control.
 *
 * What is worth pinning here is not the rendering but the SAFETY and the
 * HONESTY:
 *
 *  - the teardown is never one click, and the first click only reveals what
 *    the second would destroy;
 *  - the consequences are named one by one (app registration, bot, catalog
 *    entry, installs) — an operator approving a deletion is entitled to the
 *    list — and so is the reassurance that the bot slug survives, because
 *    that is what tells them this is a retry and not a restart;
 *  - a PARTIAL teardown renders per step. "Reset failed" as the only signal
 *    is what sends somebody into two Azure portals to find out what is left;
 *  - a run in flight locks the control, so nobody is invited into a 409.
 */

const { mockReset } = vi.hoisted(() => ({ mockReset: vi.fn() }));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  resetAgentTeamsIdentity: mockReset,
}));

function complete(): ResetAgentTeamsIdentityResponse {
  return {
    ok: true,
    agent: 'sales-bot',
    status: 'reset',
    steps: [
      { step: 'catalog_removed', outcome: 'removed' },
      { step: 'bot_deleted', outcome: 'removed' },
      { step: 'app_deleted', outcome: 'removed' },
      { step: 'identity_reset', outcome: 'removed' },
    ],
  };
}

function render(props: { state?: string; running?: boolean } = {}): {
  onDone: ReturnType<typeof vi.fn>;
} {
  const onDone = vi.fn();
  renderWithIntl(
    <AgentTeamsIdentityReset
      slug="sales-bot"
      state={props.state ?? 'failed'}
      running={props.running ?? false}
      onDone={onDone}
    />,
  );
  return { onDone };
}

/** Open the panel and tick the acknowledgement — the two steps that stand
 *  between an operator and a deletion. */
async function arm(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /zurücksetzen …|reset …/i }));
  await userEvent.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  mockReset.mockReset();
  mockReset.mockResolvedValue(complete());
});

describe('AgentTeamsIdentityReset — the confirmation', () => {
  it('does not offer a teardown for an identity that never provisioned anything', () => {
    render({ state: 'pending' });

    // A destructive control that would be a no-op only teaches operators that
    // the scary button is harmless.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('never resets on a single click', async () => {
    render();

    await userEvent.click(
      screen.getByRole('button', { name: /zurücksetzen …|reset …/i }),
    );

    expect(mockReset).not.toHaveBeenCalled();
  });

  it('names every Azure object it is about to delete', async () => {
    render();
    await userEvent.click(
      screen.getByRole('button', { name: /zurücksetzen …|reset …/i }),
    );

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Entra/i);
    expect(note).toHaveTextContent(/Bot/i);
    expect(note).toHaveTextContent(/Katalog|catalog/i);
    // And what SURVIVES — the half that makes this a retry rather than a
    // restart from a blank form.
    expect(note).toHaveTextContent(/Slug/i);
  });

  it('keeps the confirm button locked until the acknowledgement is ticked', async () => {
    render();
    await userEvent.click(
      screen.getByRole('button', { name: /zurücksetzen …|reset …/i }),
    );

    const confirm = screen.getByRole('button', {
      name: /endgültig zurücksetzen|reset for good/i,
    });
    expect(confirm).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
  });

  it('resets once armed, and asks the panel to re-read the row', async () => {
    const { onDone } = render();
    await arm();

    await userEvent.click(
      screen.getByRole('button', { name: /endgültig zurücksetzen|reset for good/i }),
    );

    await waitFor(() => expect(mockReset).toHaveBeenCalledWith('sales-bot'));
    // The teardown rewrote the row underneath the panel; rendering the state
    // it just tore down would be stale by definition.
    expect(onDone).toHaveBeenCalled();
  });

  it('locks the control while a provisioning run is in flight', () => {
    render({ running: true });

    expect(
      screen.getByRole('button', { name: /zurücksetzen …|reset …/i }),
    ).toBeDisabled();
  });
});

describe('AgentTeamsIdentityReset — the report', () => {
  it('renders each step of a completed teardown', async () => {
    render();
    await arm();
    await userEvent.click(
      screen.getByRole('button', { name: /endgültig zurücksetzen|reset for good/i }),
    );

    const report = await screen.findByTestId('teams-reset-report');
    expect(report.querySelectorAll('li')).toHaveLength(4);
  });

  it('shows a PARTIAL teardown per step instead of one failure line', async () => {
    // The connector cannot purge, so the app registration was deliberately
    // left alone — and the catalog entry really was withdrawn. Both facts
    // have to survive into the UI, or the operator opens the Azure portal.
    mockReset.mockResolvedValue({
      ok: false,
      agent: 'sales-bot',
      status: 'incomplete',
      stoppedAt: 'app_deleted',
      detail: 'purge_unsupported',
      steps: [
        { step: 'catalog_removed', outcome: 'removed' },
        { step: 'bot_deleted', outcome: 'already-absent' },
        { step: 'app_deleted', outcome: 'blocked', detail: 'purge_unsupported' },
      ],
    } satisfies ResetAgentTeamsIdentityResponse);

    render();
    await arm();
    await userEvent.click(
      screen.getByRole('button', { name: /endgültig zurücksetzen|reset for good/i }),
    );

    const report = await screen.findByTestId('teams-reset-report');
    expect(report.querySelectorAll('li')).toHaveLength(3);
    // The blocked step explains the refusal — including WHY not deleting was
    // the right move, which is the least obvious part of the whole feature.
    expect(report).toHaveTextContent(/30 Tage|30 days/);
  });

  it('falls back to the raw detail for a code it has no sentence for', async () => {
    // Failure details carry a `code:message` payload the UI cannot enumerate.
    // Showing it raw beats showing nothing.
    mockReset.mockResolvedValue({
      ok: false,
      agent: 'sales-bot',
      status: 'incomplete',
      stoppedAt: 'catalog_removed',
      detail: 'catalog_removal_failed: boom',
      steps: [
        {
          step: 'catalog_removed',
          outcome: 'failed',
          detail: 'catalog_removal_failed: boom',
        },
      ],
    } satisfies ResetAgentTeamsIdentityResponse);

    render();
    await arm();
    await userEvent.click(
      screen.getByRole('button', { name: /endgültig zurücksetzen|reset for good/i }),
    );

    expect(await screen.findByTestId('teams-reset-report')).toHaveTextContent(
      /catalog_removal_failed: boom/,
    );
  });

  it('surfaces a refused teardown as an alert', async () => {
    mockReset.mockRejectedValue(new Error('teams_provisioning_running'));

    render();
    await arm();
    await userEvent.click(
      screen.getByRole('button', { name: /endgültig zurücksetzen|reset for good/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /teams_provisioning_running/,
    );
  });
});
