import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { AgentTeamsDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentTeamsInstalls } from '../_components/AgentTeamsInstalls';

/**
 * Issue #866 (epic #860, wave W2a) — team↔agent assignment panel.
 *
 * The contract worth guarding is that the panel is CAPABILITY-DRIVEN rather
 * than hard-coded to today's platform limits:
 *
 *  - the installed-team list, its app id and the consent verdict are rendered
 *    from the derived read model;
 *  - a `false` capability yields a DISABLED control plus a localized reason —
 *    never a live button that answers 501 (`teamsProvisioner@1` publishes no
 *    uninstall today), and never the server's English reason as primary copy;
 *  - an absent capability block is parsed fail-closed, so a middleware that
 *    does not report capabilities disables everything instead of enabling a
 *    lie;
 *  - the capability flipping to `true` lights the same control up with no UI
 *    change, and uninstall stays behind a confirm;
 *  - install POSTs the team id and refreshes both this panel and the page;
 *  - every failure renders the localized copy for the machine code, never the
 *    raw `{ error: ... }` body (web-ui i18n hard rule);
 *  - 404 `teams_identity_not_found` is an empty state, not an error.
 */

const { mockGetAgentTeams, mockInstall, mockUninstall, mockRefresh } =
  vi.hoisted(() => ({
    mockGetAgentTeams: vi.fn(),
    mockInstall: vi.fn(),
    mockUninstall: vi.fn(),
    mockRefresh: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Spread the real module so parseTeamsAssignmentErrorCode and
// parseTeamsAssignmentCapabilities — the narrowing under test — stay genuine;
// only the network calls are stubbed.
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeams: mockGetAgentTeams,
  installAgentTeam: mockInstall,
  uninstallAgentTeam: mockUninstall,
}));

/** The platform's real answer today: install yes, everything else no. */
function capabilities(
  overrides: Partial<AgentTeamsDto['capabilities']> = {},
): AgentTeamsDto['capabilities'] {
  return {
    install: true,
    uninstall: false,
    enumerate: false,
    multi_team: false,
    unsupported_reason: {
      uninstall: 'teamsProvisioner@1 publishes no uninstall method',
      enumerate: 'teamsProvisioner@1 publishes no installation-listing method',
      multi_team: 'agent_teams_identities stores ONE team_id per agent',
    },
    ...overrides,
  };
}

function view(overrides: Partial<AgentTeamsDto> = {}): AgentTeamsDto {
  return {
    ok: true,
    agent: 'odoo',
    state: 'installed',
    running: false,
    provisioner_installed: true,
    teams: [
      {
        team_id: 'team-abc',
        teams_app_id: 'app-xyz',
        installed_at: '2026-08-25T09:00:00.000Z',
        evidence: 'identity_row',
      },
    ],
    pending_team_id: null,
    consent: { status: 'granted', missing_scopes: [], source: 'provisioning_state' },
    last_error: null,
    capabilities: capabilities(),
    ...overrides,
  };
}

async function renderPanel(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithIntl(<AgentTeamsInstalls slug="odoo" />);
  await screen.findByText('Teams assignment');
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentTeams.mockResolvedValue(view());
});

describe('AgentTeamsInstalls (#866)', () => {
  it('lists the team the app is installed in, with its Teams app id and consent verdict', async () => {
    await renderPanel();

    expect(await screen.findByText('team-abc')).toBeTruthy();
    expect(screen.getByText('Teams app: app-xyz')).toBeTruthy();
    expect(screen.getByText((s) => s.startsWith('recorded '))).toBeTruthy();
    expect(screen.getByText('granted')).toBeTruthy();
    expect(
      screen.getByText(
        'Inferred from steps the run could not have passed without consent.',
      ),
    ).toBeTruthy();
    // The list is derived, not enumerated — and the caveat is tied to the
    // capability flag, so it disappears the day the connector can list.
    expect(
      screen.getByText(
        'The connector cannot list installs, so this view reports what the provisioning record proves rather than what Teams currently holds.',
      ),
    ).toBeTruthy();
  });

  it('surfaces missing consent with the scopes the tenant still owes', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [],
        state: 'app_registered',
        consent: {
          status: 'missing',
          missing_scopes: ['AppCatalog.ReadWrite.All', 'TeamsAppInstallation.ReadWriteForTeam.All'],
          source: 'last_error',
        },
      }),
    );
    await renderPanel();

    expect(await screen.findByText('missing')).toBeTruthy();
    expect(
      screen.getByText(
        'Waiting on 2 permission(s): AppCatalog.ReadWrite.All, TeamsAppInstallation.ReadWriteForTeam.All',
      ),
    ).toBeTruthy();
    // The remediation copy belongs to the Teams identity panel — this one
    // points at it instead of duplicating the consent instructions.
    expect(
      screen.getByText('The Teams identity section above explains what to do about it.'),
    ).toBeTruthy();
  });

  it('disables uninstall and states why while the connector publishes none', async () => {
    await renderPanel();

    const button = await screen.findByRole('button', { name: 'Uninstall' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        'Removing the app from a team is a manual Teams-admin step — the Microsoft 365 connector publishes no uninstall, so omadia cannot do it for you.',
      ),
    ).toBeTruthy();
    // The server's English engineering sentence may appear only as a
    // secondary technical detail, never as the operator-facing copy.
    expect(
      screen.getByText(
        'Server reason: teamsProvisioner@1 publishes no uninstall method',
      ),
    ).toBeTruthy();
  });

  it('parses a missing capability block fail-closed — every control disabled', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ capabilities: undefined as unknown as AgentTeamsDto['capabilities'] }),
    );
    await renderPanel();

    expect(
      (await screen.findByRole('button', { name: 'Uninstall' })).hasAttribute('disabled'),
    ).toBe(true);
    expect((screen.getByLabelText('Team ID') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText('Installing into a team is not available in this deployment.'),
    ).toBeTruthy();
  });

  it('keeps install disabled once a team is tracked and multi_team is unsupported', async () => {
    await renderPanel();

    expect((screen.getByLabelText('Team ID') as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText(
        'One orchestrator is tracked in one team. Assigning a second team would leave the first install untracked, so it is refused.',
      ),
    ).toBeTruthy();
  });

  it('installs into a team and refreshes the panel and the page', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ teams: [], state: 'app_registered', consent: { status: 'unknown', missing_scopes: [], source: 'none' } }),
    );
    mockInstall.mockResolvedValue({
      ok: true,
      agent: 'odoo',
      team_id: 'team-new',
      state: 'app_registered',
      already_installed: false,
      running: true,
    });
    const user = await renderPanel();

    await user.type(await screen.findByLabelText('Team ID'), 'team-new');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledWith('odoo', 'team-new'));
    expect(
      await screen.findByText(
        'Installing into team team-new — the provisioning run continues in the background.',
      ),
    ).toBeTruthy();
    // Two loads: the mount fetch and the post-write refresh.
    expect(mockGetAgentTeams).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('maps a rejected install to the localized code copy, never the raw body', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ teams: [], state: 'app_registered' }),
    );
    mockInstall.mockRejectedValue(
      new ApiError(409, 'Conflict', '{"error":"team_install_conflict"}'),
    );
    const user = await renderPanel();

    await user.type(await screen.findByLabelText('Team ID'), 'team-two');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(
      await screen.findByText(
        'This orchestrator is already assigned to another team. Remove that assignment first — one orchestrator is tracked in one team.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/team_install_conflict/)).toBeNull();
  });

  it('uninstalls behind a confirm once the connector publishes one', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ capabilities: capabilities({ uninstall: true }) }),
    );
    mockUninstall.mockResolvedValue(undefined);
    const user = await renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    expect(mockUninstall).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockUninstall).toHaveBeenCalledWith('odoo', 'team-abc'));
    expect(await screen.findByText('Removed the app from team team-abc.')).toBeTruthy();
  });

  it('renders 404 teams_identity_not_found as an empty state, not an error', async () => {
    mockGetAgentTeams.mockRejectedValue(
      new ApiError(404, 'Not Found', '{"error":"teams_identity_not_found"}'),
    );
    await renderPanel();

    expect(
      await screen.findByText(
        'This orchestrator has no Teams identity yet. Create one in the Teams identity section before assigning it to a team.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the 503 provisioner gate as an informational notice', async () => {
    mockGetAgentTeams.mockRejectedValue(
      new ApiError(503, 'Unavailable', '{"error":"teams_provisioner_unavailable"}'),
    );
    await renderPanel();

    expect(
      await screen.findByText(
        'The Teams provisioner capability is missing — install and activate the Microsoft 365 connector plugin (0.3.1 or newer), then reload this page.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a run in flight as a target, never as an install', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [],
        state: 'catalog_uploaded',
        pending_team_id: 'team-pending',
        running: true,
      }),
    );
    await renderPanel();

    expect(
      await screen.findByText(
        'A provisioning run is targeting team team-pending. It counts as an install once the chain reaches the install step.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("This orchestrator's app is not installed in any team yet."),
    ).toBeTruthy();
  });
});
