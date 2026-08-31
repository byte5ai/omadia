import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type { TeamsIdentityStatusDto } from '../../../../_lib/agents';
import { AgentTeamsIdentity } from '../_components/AgentTeamsIdentity';

/**
 * Epic #860, wave W2a — the per-agent Teams identity panel: create form,
 * readable state machine, live polling.
 *
 * What these tests pin, beyond "it renders":
 *   - 404 `teams_identity_not_found` is the CREATE signal, not an error. The
 *     two 503 capability gates are informational notices, not alarms. Getting
 *     this wrong makes a fresh install look broken.
 *   - Polling stops at a terminal state and is torn down on unmount — a panel
 *     that keeps hammering GET after `installed` is a production regression
 *     that no render assertion would catch.
 *   - `last_error` is rendered from the SERVER-SIDE classification
 *     (`last_error_detail`), never by parsing the English sentence here. The
 *     raw sentence may only appear as a secondary technical detail.
 *   - Raw API bodies never reach the UI (web-ui i18n hard rule).
 */

const { mockGet, mockProvision } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProvision: vi.fn(),
}));

// Spread the real module so the error-code parser and the last_error narrower
// (the shared contracts this UI maps to catalogue keys) stay genuine; only the
// two network calls are stubbed.
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeamsIdentity: mockGet,
  provisionAgentTeamsIdentity: mockProvision,
}));

function statusDto(
  overrides: Partial<TeamsIdentityStatusDto> = {},
): TeamsIdentityStatusDto {
  return {
    ok: true,
    agent: 'sales-bot',
    state: 'bot_created',
    running: true,
    provisioner_installed: true,
    identity: {
      bot_slug: 'sales-bot',
      display_name: 'Sales Bot',
      app_id: '11111111-2222-3333-4444-555555555555',
      tenant_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      teams_app_id: null,
      teams_app_external_id: null,
      team_id: '19:team-a',
      last_error: null,
      created_at: '2026-08-27T08:00:00.000Z',
      updated_at: '2026-08-27T08:05:00.000Z',
    },
    teams_bot: null,
    ...overrides,
  };
}

function apiError(status: number, code: string): ApiError {
  return new ApiError(
    status,
    `GET /v1/operator/agents/sales-bot/teams-identity failed: ${status}`,
    JSON.stringify({ error: code }),
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockProvision.mockReset();
  mockGet.mockResolvedValue(statusDto());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentTeamsIdentity (#860 W2a)', () => {
  it('shows the create form when the agent has no identity row yet', async () => {
    mockGet.mockRejectedValue(apiError(404, 'teams_identity_not_found'));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(
      await screen.findByRole('button', { name: 'Start provisioning' }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Bot slug/)).toBeTruthy();
    expect(screen.getByLabelText(/Display name/)).toBeTruthy();
    expect(screen.getByLabelText(/Target team ID/)).toBeTruthy();
    // "No identity yet" is the form's trigger, not a failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('submits only the fields the operator filled in, then reloads the status', async () => {
    mockGet.mockRejectedValueOnce(apiError(404, 'teams_identity_not_found'));
    mockProvision.mockResolvedValue({
      ok: true,
      agent: 'sales-bot',
      bot_slug: 'sales-bot',
      state: 'pending',
      running: true,
    });
    mockGet.mockResolvedValue(statusDto({ state: 'pending' }));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Target team ID/),
      '19:meeting@thread.tacv2',
    );
    await user.click(screen.getByRole('button', { name: 'Start provisioning' }));

    // Empty optional fields are omitted so the server derives them.
    await waitFor(() =>
      expect(mockProvision).toHaveBeenCalledWith('sales-bot', {
        team_id: '19:meeting@thread.tacv2',
      }),
    );
    expect(
      await screen.findByText('Provisioning started for sales-bot.'),
    ).toBeTruthy();
    expect(await screen.findByText('State: pending')).toBeTruthy();
  });

  it('renders every provisioning state readably, marking the current step', async () => {
    for (const [state, label] of [
      ['pending', 'pending'],
      ['app_registered', 'app registered'],
      ['bot_created', 'bot created'],
      ['package_built', 'package built'],
      ['catalog_uploaded', 'catalog uploaded'],
      ['installed', 'installed'],
      ['failed', 'failed'],
    ] as const) {
      mockGet.mockResolvedValue(statusDto({ state }));
      const { unmount } = renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);
      expect(await screen.findByText(`State: ${label}`)).toBeTruthy();

      const chain = screen.getByRole('list', { name: 'Provisioning progress' });
      // `failed` is a sink, not a chain step — it must not claim a position.
      const current = within(chain).queryByRole('listitem', { current: 'step' });
      if (state === 'failed') {
        expect(current).toBeNull();
      } else {
        expect(current?.textContent).toBe(label);
      }
      unmount();
    }
  });

  it('polls the status endpoint while the run is non-terminal and stops at a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(statusDto({ state: 'package_built' }));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    mockGet.mockResolvedValue(statusDto({ state: 'catalog_uploaded' }));
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    // Terminal: the interval must be torn down, not merely skipped.
    mockGet.mockResolvedValue(
      statusDto({ state: 'installed', running: false }),
    );
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('State: installed')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('cancels polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(statusDto({ state: 'pending' }));
    const { unmount } = renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('renders the SERVER-classified last error, keeping the raw sentence secondary', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        state: 'failed',
        running: false,
        identity: {
          ...statusDto().identity,
          last_error:
            'consent_missing: admin consent required for scopes [AppCatalog.ReadWrite.All, TeamsAppInstallation.ReadWriteForTeam.All] — grant them in the customer tenant, then re-run provisioning',
          last_error_detail: {
            code: 'consent_missing',
            scopes: [
              'AppCatalog.ReadWrite.All',
              'TeamsAppInstallation.ReadWriteForTeam.All',
            ],
            raw: 'consent_missing: admin consent required for scopes […]',
          },
        },
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const alert = await screen.findByRole('alert');
    // What happened, the captured scopes, what to do next — all from the
    // server's `code` plus its typed arguments, never from the sentence.
    expect(alert.textContent).toContain('has not granted admin consent');
    expect(alert.textContent).toContain('AppCatalog.ReadWrite.All');
    expect(alert.textContent).toContain('Ask a Global Administrator');
    expect(
      within(alert).getByRole('link', {
        name: 'How to grant admin consent in Microsoft Entra ID',
      }),
    ).toBeTruthy();
    // The raw sentence is a collapsed technical detail, never the message.
    expect(within(alert).getByText('Technical detail')).toBeTruthy();
    expect(
      alert.querySelector('p:not(.font-medium)')?.textContent,
    ).not.toContain('consent_missing:');
  });

  it('falls back to the localized unknown-error copy when the server sends no classification', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        state: 'app_registered',
        running: false,
        identity: {
          ...statusDto().identity,
          last_error: 'arm subscription lookup timed out',
        },
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Provisioning stopped for a reason omadia cannot classify',
    );
    // The sentence still reaches the operator — as the technical detail.
    expect(alert.textContent).toContain('arm subscription lookup timed out');
    // A parked run on a non-terminal state is still in flight.
    expect(screen.getByText('State: app registered')).toBeTruthy();
  });

  it('treats both 503 capability gates as informational, not as alarms', async () => {
    for (const [code, copy] of [
      [
        'teams_identity_unavailable',
        'Teams identity provisioning is not wired in this deployment',
      ],
      [
        'teams_provisioner_unavailable',
        'The Teams provisioner capability is missing',
      ],
    ] as const) {
      mockGet.mockRejectedValue(apiError(503, code));
      const { unmount } = renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

      const status = await screen.findByRole('status');
      expect(status.textContent).toContain(copy);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(code)).toBeNull();
      unmount();
    }
  });

  it('maps a 409 bot_slug_taken to localized copy and keeps the form filled in', async () => {
    mockGet.mockRejectedValue(apiError(404, 'teams_identity_not_found'));
    mockProvision.mockRejectedValue(apiError(409, 'bot_slug_taken'));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Bot slug/), 'taken-slug');
    // `team_id` is required by the server, so the form requires it too — the
    // submit button stays disabled until it is filled in.
    await user.type(screen.getByLabelText(/Target team ID/), '19:team-a');
    await user.click(screen.getByRole('button', { name: 'Start provisioning' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'That bot slug already belongs to another orchestrator — pick a different one.',
    );
    expect(alert.textContent).not.toContain('bot_slug_taken');
    // The operator's input survives so they can edit it.
    expect(screen.getByLabelText(/Bot slug/)).toHaveProperty(
      'value',
      'taken-slug',
    );
  });

  it('falls back to the localized unknown sentence with the technical detail', async () => {
    mockGet.mockRejectedValue(new Error('socket hang up'));
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The Teams identity request failed:');
    expect(alert.textContent).toContain('socket hang up');
  });

  it('shows the identity facts and marks the not-yet-assigned ones as such', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(
      await screen.findByText('11111111-2222-3333-4444-555555555555'),
    ).toBeTruthy();
    expect(screen.getAllByText('not assigned yet')).toHaveLength(2);
    expect(screen.getByText('A provisioning run is in progress.')).toBeTruthy();
  });

  it('offers a re-run only once the run has ended', async () => {
    mockGet.mockResolvedValue(statusDto({ state: 'failed', running: false }));
    mockProvision.mockResolvedValue({
      ok: true,
      agent: 'sales-bot',
      bot_slug: 'sales-bot',
      state: 'pending',
      running: true,
    });
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Re-run provisioning' }),
    );
    // The server REQUIRES `team_id` on every POST and has no fall-back-to-
    // stored path (`ensureForAgent` refreshes it from the request, and the
    // route hands `body.team_id` straight to the runner), so a re-run has to
    // resend the recorded target. An empty body would 400 every single time.
    await waitFor(() =>
      expect(mockProvision).toHaveBeenCalledWith('sales-bot', {
        team_id: '19:team-a',
      }),
    );
  });

  it('replaces the re-run with a target chooser when nothing is recorded', async () => {
    // This used to render a DISABLED re-run button plus a sentence explaining
    // why it could not work, which is how the reset dead end got shipped: a
    // reset nulls `team_id`, so the panel's only two ways to start a run both
    // vanished and the agent could only be deleted. A control that can never
    // fire is not the right answer to "no target" — asking for one is.
    // Fully covered in `AgentTeamsIdentity.restart.test.tsx`.
    mockGet.mockResolvedValue(
      statusDto({
        state: 'failed',
        running: false,
        identity: { ...statusDto().identity, team_id: null },
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(await screen.findByTestId('teams-identity-target')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Re-run provisioning' }),
    ).toBeNull();
  });

  it('hides the re-run button while a run is still in flight', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);
    await screen.findByText('State: bot created');
    expect(
      screen.queryByRole('button', { name: 'Re-run provisioning' }),
    ).toBeNull();
  });
});
