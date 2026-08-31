import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { ResetAgentTeamsIdentityResponse } from '../../../../_lib/agents';
import { AgentTeamsIdentityReset } from '../_components/AgentTeamsIdentityReset';

/**
 * The destructive controls.
 *
 * What is worth pinning here is not the rendering but the SAFETY and the
 * HONESTY:
 *
 *  - neither teardown is ever one click, and the first click only reveals what
 *    the second would destroy;
 *  - the consequences are named one by one (app registration, bot, catalog
 *    entry, installs) — an operator approving a deletion is entitled to the
 *    list — and so is the statement of what SURVIVES, which is the single
 *    fact that separates the two variants;
 *  - THE TWO ARE NOT INTERCHANGEABLE and must not be confusable. Resetting the
 *    run keeps the bot slug; deleting the identity frees it. The second one
 *    therefore costs more than a checkbox: the operator has to type the slug,
 *    which is the one confirmation nobody performs by reflex;
 *  - a PARTIAL teardown renders per step. "Reset failed" as the only signal
 *    is what sends somebody into two Azure portals to find out what is left;
 *  - a run in flight locks the controls, so nobody is invited into a 409.
 */

const { mockReset } = vi.hoisted(() => ({ mockReset: vi.fn() }));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  resetAgentTeamsIdentity: mockReset,
}));

const BOT_SLUG = 'sales-bot-01';

const OPEN_RUN = /Reset the run …|Lauf zurücksetzen …/i;
const OPEN_IDENTITY = /Delete the identity …|Identität löschen …/i;
const CONFIRM_RUN = /^(Reset the run|Lauf zurücksetzen)$/;
const CONFIRM_IDENTITY =
  /Delete the identity for good|Identität endgültig löschen/i;

function complete(): ResetAgentTeamsIdentityResponse {
  return {
    ok: true,
    agent: 'sales-bot',
    status: 'reset',
    scope: 'run',
    steps: [
      { step: 'catalog_removed', outcome: 'removed' },
      { step: 'bot_deleted', outcome: 'removed' },
      { step: 'app_deleted', outcome: 'removed' },
      { step: 'identity_reset', outcome: 'removed' },
    ],
  };
}

function completeIdentity(): ResetAgentTeamsIdentityResponse {
  return {
    ok: true,
    agent: 'sales-bot',
    status: 'reset',
    scope: 'identity',
    steps: [
      { step: 'catalog_removed', outcome: 'removed' },
      { step: 'bot_deleted', outcome: 'removed' },
      { step: 'app_deleted', outcome: 'removed' },
      { step: 'identity_deleted', outcome: 'removed' },
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
      botSlug={BOT_SLUG}
      state={props.state ?? 'failed'}
      running={props.running ?? false}
      onDone={onDone}
    />,
  );
  return { onDone };
}

/** Open the milder panel and tick the acknowledgement — the two steps that
 *  stand between an operator and a teardown. */
async function armRun(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));
  await userEvent.click(screen.getByRole('checkbox'));
}

/** Open the destructive panel and clear BOTH of its gates. */
async function armIdentity(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.type(screen.getByRole('textbox'), BOT_SLUG);
}

beforeEach(() => {
  mockReset.mockReset();
  mockReset.mockResolvedValue(complete());
});

describe('AgentTeamsIdentityReset — the confirmation', () => {
  it('offers only the identity deletion for a row that never provisioned anything', () => {
    render({ state: 'pending' });

    // Resetting the RUN would be a no-op — there is nothing in Azure — and a
    // scary button that does nothing teaches operators that scary buttons are
    // harmless. Deleting the identity is a different matter: the row still
    // holds a UNIQUE bot slug, and this is the only way to free it.
    expect(screen.queryByRole('button', { name: OPEN_RUN })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPEN_IDENTITY })).toBeInTheDocument();
  });

  it('never tears down on a single click, in either variant', async () => {
    render();

    await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));
    expect(mockReset).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('names every Azure object it is about to delete', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));

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
    await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));

    const confirm = screen.getByRole('button', { name: CONFIRM_RUN });
    expect(confirm).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
  });

  it('resets the run once armed, and asks the panel to re-read the row', async () => {
    const { onDone } = render();
    await armRun();

    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

    await waitFor(() =>
      expect(mockReset).toHaveBeenCalledWith('sales-bot', 'run'),
    );
    // The teardown rewrote the row underneath the panel; rendering the state
    // it just tore down would be stale by definition.
    expect(onDone).toHaveBeenCalled();
  });

  it('locks both controls while a provisioning run is in flight', () => {
    render({ running: true });

    expect(screen.getByRole('button', { name: OPEN_RUN })).toBeDisabled();
    expect(screen.getByRole('button', { name: OPEN_IDENTITY })).toBeDisabled();
  });

  it('shows one confirmation at a time, never two with different consequences', async () => {
    render();

    await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));
    expect(screen.getByTestId('teams-reset-confirm-run')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));
    expect(screen.getByTestId('teams-reset-confirm-identity')).toBeInTheDocument();
    expect(screen.queryByTestId('teams-reset-confirm-run')).not.toBeInTheDocument();
  });
});

/**
 * THE DESTRUCTIVE VARIANT — the one that throws away answers a human gave
 * rather than identifiers Azure handed back, and therefore has to be harder
 * to trigger and impossible to mistake for the other one.
 */
describe('AgentTeamsIdentityReset — deleting the identity', () => {
  it('says the slug and the name go too, in as many words', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));

    const note = screen.getByTestId('teams-reset-confirm-identity');
    // The one fact that separates the two teardowns must be stated, not
    // implied by the absence of the reassurance the other one carries.
    expect(note).toHaveTextContent(/NOT kept|NICHT behalten/i);
    expect(note).toHaveTextContent(/freely choosable|frei wählbar/i);
  });

  it('needs the bot slug TYPED, not just a checkbox', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));

    const confirm = screen.getByRole('button', { name: CONFIRM_IDENTITY });
    await userEvent.click(screen.getByRole('checkbox'));
    // The acknowledgement alone arms the MILD reset. It must not arm this one.
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox'), BOT_SLUG);
    expect(confirm).toBeEnabled();
  });

  it('refuses a slug that is not this identity`s, and says so', async () => {
    render();
    await userEvent.click(screen.getByRole('button', { name: OPEN_IDENTITY }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByRole('textbox'), 'sales-bot-02');

    expect(screen.getByRole('button', { name: CONFIRM_IDENTITY })).toBeDisabled();
    expect(screen.getByTestId('teams-reset-confirm-identity')).toHaveTextContent(
      /not the bot slug|stimmt nicht überein/i,
    );
  });

  it('sends the identity scope — never silently the milder one', async () => {
    // The two differ by a VALUE and not by an omission, precisely so this
    // assertion can exist.
    const { onDone } = render();
    await armIdentity();

    await userEvent.click(screen.getByRole('button', { name: CONFIRM_IDENTITY }));

    await waitFor(() =>
      expect(mockReset).toHaveBeenCalledWith('sales-bot', 'identity'),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('tells the operator the identity can now be created afresh', async () => {
    // THE POINT OF THE WHOLE FEATURE. After this the panel's parent re-reads
    // the row, gets a 404, and renders the create form with an empty slug —
    // so the success line has to promise exactly that and not the milder
    // "you can provision again with the same name".
    mockReset.mockResolvedValue(completeIdentity());

    render();
    await armIdentity();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_IDENTITY }));

    const report = await screen.findByTestId('teams-reset-report');
    expect(report).toHaveTextContent(/new bot slug|neuen Bot-Slug/i);
    // And the row step is reported as the deletion it was.
    expect(report.querySelectorAll('li')).toHaveLength(4);
  });

  it('explains a refusal to drop the row rather than reporting a bare failure', async () => {
    // The subtle refusal: Azure is clean, but nobody could prove the app
    // registration is gone, and the row is the only trace left pointing at
    // it. The operator has to understand that this is a deliberate stop.
    mockReset.mockResolvedValue({
      ok: false,
      agent: 'sales-bot',
      status: 'incomplete',
      scope: 'identity',
      stoppedAt: 'identity_deleted',
      detail: 'app_trace_required',
      steps: [
        { step: 'catalog_removed', outcome: 'removed' },
        { step: 'bot_deleted', outcome: 'removed' },
        {
          step: 'app_deleted',
          outcome: 'already-absent',
          detail: 'app_absent_unpurgeable',
        },
        {
          step: 'identity_deleted',
          outcome: 'blocked',
          detail: 'app_trace_required',
        },
      ],
    } satisfies ResetAgentTeamsIdentityResponse);

    render();
    await armIdentity();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_IDENTITY }));

    const report = await screen.findByTestId('teams-reset-report');
    expect(report).toHaveTextContent(/only trace|einzige Spur/i);
    // And it points at the way forward that DOES work.
    expect(report).toHaveTextContent(/reset the run|Lauf zurücksetzen/i);
  });
});

describe('AgentTeamsIdentityReset — the report', () => {
  it('renders each step of a completed teardown', async () => {
    render();
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

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
      scope: 'run',
      stoppedAt: 'app_deleted',
      detail: 'purge_unsupported',
      steps: [
        { step: 'catalog_removed', outcome: 'removed' },
        { step: 'bot_deleted', outcome: 'already-absent' },
        { step: 'app_deleted', outcome: 'blocked', detail: 'purge_unsupported' },
      ],
    } satisfies ResetAgentTeamsIdentityResponse);

    render();
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

    const report = await screen.findByTestId('teams-reset-report');
    expect(report.querySelectorAll('li')).toHaveLength(3);
    // The blocked step explains the refusal — including WHY not deleting was
    // the right move, which is the least obvious part of the whole feature.
    expect(report).toHaveTextContent(/30 Tage|30 days/);
  });

  it('names an expired tenant sign-in as expired, not as a missing one', async () => {
    // The teardown's half of the field-test bug: the catalog withdrawal is
    // delegated-only and runs first, so a spent token used to abort the whole
    // reset. Now it refreshes — and when even that fails, the copy has to say
    // "your sign-in expired", never "sign in", to someone already signed in.
    mockReset.mockResolvedValue({
      ok: false,
      agent: 'sales-bot',
      status: 'incomplete',
      scope: 'run',
      stoppedAt: 'catalog_removed',
      detail: 'tenant_sign_in_expired',
      steps: [
        {
          step: 'catalog_removed',
          outcome: 'blocked',
          detail: 'tenant_sign_in_expired',
        },
      ],
    } satisfies ResetAgentTeamsIdentityResponse);

    render();
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

    const report = await screen.findByTestId('teams-reset-report');
    expect(report).toHaveTextContent(/expired|abgelaufen/i);
  });

  it('falls back to the raw detail for a code it has no sentence for', async () => {
    // Failure details carry a `code:message` payload the UI cannot enumerate.
    // Showing it raw beats showing nothing.
    mockReset.mockResolvedValue({
      ok: false,
      agent: 'sales-bot',
      status: 'incomplete',
      scope: 'run',
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
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

    expect(await screen.findByTestId('teams-reset-report')).toHaveTextContent(
      /catalog_removal_failed: boom/,
    );
  });

  it('surfaces a refused teardown as an alert', async () => {
    mockReset.mockRejectedValue(new Error('teams_provisioning_running'));

    render();
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /teams_provisioning_running/,
    );
  });

  it('does not leak the previous panel`s arming into the next teardown', async () => {
    // A confirmation that stayed ticked after a completed teardown would make
    // the NEXT one a single click.
    render();
    await armRun();
    await userEvent.click(screen.getByRole('button', { name: CONFIRM_RUN }));
    await screen.findByTestId('teams-reset-report');

    await userEvent.click(screen.getByRole('button', { name: OPEN_RUN }));
    expect(screen.getByRole('button', { name: CONFIRM_RUN })).toBeDisabled();
    expect(within(screen.getByRole('note')).getByRole('checkbox')).not.toBeChecked();
  });
});
