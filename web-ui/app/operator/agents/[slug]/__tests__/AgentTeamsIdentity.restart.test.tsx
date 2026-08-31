import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type {
  AgentTeamsTargetsDto,
  TeamsIdentityStatusDto,
} from '../../../../_lib/agents';
import { AgentTeamsIdentity } from '../_components/AgentTeamsIdentity';

/**
 * Getting back OUT of a target-less identity.
 *
 * THE FIELD-TEST DEAD END. A reset returns the row to `pending` and nulls
 * `team_id`. The panel then had no control at all that could start a run: the
 * create form renders only when NO row exists, and "provision again" was
 * `disabled` without a recorded target — because the POST requires `team_id`
 * and the server has no re-run-as-recorded path. Status "PENDING", every field
 * empty, nothing to click. The only remaining move was deleting the agent.
 *
 * WHAT IS PINNED HERE, and deliberately in terms of STATE rather than history:
 *   - an identity with NO target offers a chooser and can start a run with it;
 *   - `bot_slug` and `display_name` are NOT resent — they survive a reset, and
 *     re-sending them could only introduce a difference nobody asked for;
 *   - an identity WITH a target is untouched: it keeps the re-run button and
 *     never grows a second, competing way to start the same run.
 *
 * Nothing here observes "was reset", and nothing may: a row reaches this shape
 * by other routes too, and a test keyed on history would pass while the panel
 * stayed broken for all of them.
 */

const { mockGet, mockProvision, mockTargets } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProvision: vi.fn(),
  mockTargets: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeamsIdentity: mockGet,
  provisionAgentTeamsIdentity: mockProvision,
  getAgentTeamsTargets: mockTargets,
}));

const TEAM_ID = '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c';

function statusDto(
  identity: Partial<TeamsIdentityStatusDto['identity']> = {},
  overrides: Partial<TeamsIdentityStatusDto> = {},
): TeamsIdentityStatusDto {
  return {
    ok: true,
    agent: 'sales-bot',
    // What a reset leaves behind: the chain is back at the start and nothing
    // is running, so no poll and no in-flight run can explain the missing
    // control away.
    state: 'pending',
    running: false,
    provisioner_installed: true,
    identity: {
      bot_slug: 'sales-bot',
      display_name: 'Sales Bot',
      app_id: null,
      tenant_id: null,
      teams_app_id: null,
      teams_app_external_id: null,
      team_id: null,
      last_error: null,
      created_at: '2026-08-27T08:00:00.000Z',
      updated_at: '2026-08-27T09:00:00.000Z',
      ...identity,
    },
    teams_bot: null,
    ...overrides,
  };
}

function targetsDto(): AgentTeamsTargetsDto {
  return {
    ok: true,
    agent: 'sales-bot',
    provisioner_installed: true,
    teams: { available: true, items: [{ id: TEAM_ID, displayName: 'Acme Team' }] },
    chats: { available: false, reason: 'sign_in_required' },
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockProvision.mockReset();
  mockTargets.mockReset();
  mockGet.mockResolvedValue(statusDto());
  mockTargets.mockResolvedValue(targetsDto());
  mockProvision.mockResolvedValue({
    ok: true,
    agent: 'sales-bot',
    bot_slug: 'sales-bot',
    state: 'pending',
    running: true,
  });
});

describe('AgentTeamsIdentity — an identity with no install target', () => {
  it('offers a way to name a target instead of a dead end', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    // THE REGRESSION GUARD. Without the fix this panel renders a state badge,
    // a chain and nothing operable — every assertion below fails on the very
    // first one.
    expect(await screen.findByTestId('teams-identity-target')).toBeInTheDocument();
    expect(await screen.findByLabelText('Target ID')).toBeInTheDocument();
  });

  it('starts a run with the typed target and resends nothing else', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await user.type(await screen.findByLabelText('Target ID'), TEAM_ID);
    await user.click(
      screen.getByRole('button', { name: 'Start provisioning' }),
    );

    await waitFor(() => expect(mockProvision).toHaveBeenCalledTimes(1));
    // Exactly the target, and nothing else. `bot_slug` and `display_name`
    // survive a reset on purpose; the server ignores them on an existing row,
    // so resending them could only ever introduce a difference.
    expect(mockProvision).toHaveBeenCalledWith('sales-bot', { team_id: TEAM_ID });
  });

  it('starts a run with a target picked from the tenant list', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await user.click(await screen.findByRole('combobox', { name: /Team/i }));
    await user.click(await screen.findByRole('option', { name: 'Acme Team' }));
    await user.click(screen.getByRole('button', { name: 'Start provisioning' }));

    await waitFor(() =>
      expect(mockProvision).toHaveBeenCalledWith('sales-bot', { team_id: TEAM_ID }),
    );
  });

  it('refuses to start on an input that is not an install target', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    // A channel id: five provisioning steps used to run before Graph said no.
    await user.type(
      await screen.findByLabelText('Target ID'),
      '19:abc123@thread.tacv2',
    );

    expect(
      (
        screen.getByRole('button', {
          name: 'Start provisioning',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('still offers the chooser after a run has FAILED without a target', async () => {
    // The condition is "no target", not "was reset" — a terminal failure with
    // a nulled target must be just as startable.
    mockGet.mockResolvedValue(statusDto({}, { state: 'failed', running: false }));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(await screen.findByTestId('teams-identity-target')).toBeInTheDocument();
    // And the affordance that cannot work is not offered alongside it.
    expect(
      screen.queryByRole('button', { name: 'Re-run provisioning' }),
    ).not.toBeInTheDocument();
  });
});

describe('AgentTeamsIdentity — an identity that HAS a target', () => {
  it('keeps the re-run button and grows no second way to start', async () => {
    mockGet.mockResolvedValue(
      statusDto({ team_id: TEAM_ID }, { state: 'installed', running: false }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const rerun = await screen.findByRole('button', { name: 'Re-run provisioning' });
    expect((rerun as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('teams-identity-target')).not.toBeInTheDocument();
  });

  it('resends the recorded target verbatim', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(
      statusDto({ team_id: TEAM_ID }, { state: 'installed', running: false }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await user.click(
      await screen.findByRole('button', { name: 'Re-run provisioning' }),
    );

    await waitFor(() =>
      expect(mockProvision).toHaveBeenCalledWith('sales-bot', { team_id: TEAM_ID }),
    );
  });

  it('does not enumerate the tenant for an identity that needs no target', async () => {
    mockGet.mockResolvedValue(
      statusDto({ team_id: TEAM_ID }, { state: 'installed', running: false }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await screen.findByRole('button', { name: 'Re-run provisioning' });
    // The directory costs the connector Graph calls; a panel with nothing to
    // pick has no business spending them.
    expect(mockTargets).not.toHaveBeenCalled();
  });
});
