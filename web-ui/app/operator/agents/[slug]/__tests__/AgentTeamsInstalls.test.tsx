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
    chat_install: false,
    unsupported_reason: {
      uninstall:
        'the installed teamsProvisioner@1 publishes no uninstallFromTeam method',
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

  it('disables uninstall and names the fix when the connector is too old (#900)', async () => {
    await renderPanel();

    const button = await screen.findByRole('button', { name: 'Uninstall' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The copy has to be actionable: this is a version skew the operator can
    // fix by upgrading the plugin, not a platform limit they must live with.
    expect(
      screen.getByText(
        'Removing the app from a team needs Microsoft 365 connector 0.4.0 or newer. The connector installed here is older and publishes no uninstall — upgrade the plugin, or have a Teams administrator remove the app manually.',
      ),
    ).toBeTruthy();
    // The server's English engineering sentence may appear only as a
    // secondary technical detail, never as the operator-facing copy.
    expect(
      screen.getByText(
        'Server reason: the installed teamsProvisioner@1 publishes no uninstallFromTeam method',
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
    expect((screen.getByLabelText('Target ID') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText('Installing into a team is not available in this deployment.'),
    ).toBeTruthy();
  });

  it('keeps install disabled once a team is tracked and multi_team is unsupported', async () => {
    await renderPanel();

    expect((screen.getByLabelText('Target ID') as HTMLInputElement).disabled).toBe(true);
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
      team_id: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
      state: 'app_registered',
      already_installed: false,
      running: true,
    });
    const user = await renderPanel();

    await user.type(await screen.findByLabelText('Target ID'), '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledWith('odoo', '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c'));
    expect(
      await screen.findByText(
        'Installing into team 2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c — the provisioning run continues in the background.',
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

    await user.type(await screen.findByLabelText('Target ID'), '3e2b8d55-2a1f-4b3d-9e2b-8d552a1f4b3d');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(
      await screen.findByText(
        'This orchestrator is already assigned to another team. Remove that assignment first — one orchestrator is tracked in one team.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/team_install_conflict/)).toBeNull();
  });

  // ── migration 0051: several bindings, shown by NAME ──────────────────

  it('lists every attached team by name, resolving the id beneath it', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [
          {
            team_id: 'team-abc',
            team_display_name: 'Marketing',
            display_name_synced_at: '2026-08-28T08:00:00.000Z',
            teams_app_id: 'app-xyz',
            installed_at: '2026-08-25T09:00:00.000Z',
            evidence: 'install_row',
          },
          {
            team_id: 'team-def',
            team_display_name: 'Vertrieb',
            display_name_synced_at: '2026-08-28T08:00:00.000Z',
            teams_app_id: 'app-xyz',
            installed_at: '2026-08-26T09:00:00.000Z',
            evidence: 'install_row',
          },
        ],
        capabilities: capabilities({ uninstall: true, multi_team: true }),
      }),
    );
    await renderPanel();

    // Both bindings are listed — the whole point of the persisted table.
    expect(await screen.findByText('Marketing')).toBeTruthy();
    expect(screen.getByText('Vertrieb')).toBeTruthy();
    // The id stays visible: it is what addresses the team unambiguously.
    expect(screen.getByText('team-abc')).toBeTruthy();
    expect(screen.getByText('team-def')).toBeTruthy();
  });

  it('falls back to the bare id, and says why, when no name was resolved', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [
          {
            team_id: 'team-abc',
            team_display_name: null,
            display_name_synced_at: null,
            teams_app_id: 'app-xyz',
            installed_at: '2026-08-25T09:00:00.000Z',
            evidence: 'install_row',
          },
        ],
      }),
    );
    await renderPanel();

    expect(await screen.findByText('team-abc')).toBeTruthy();
    // A naked GUID with no explanation reads as a bug; the copy says it is not.
    expect(
      screen.getByText(
        'Name not resolved — the M365 connector cannot provide it right now.',
      ),
    ).toBeTruthy();
  });

  it('names the team in the uninstall confirmation, id included', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [
          {
            team_id: 'team-abc',
            team_display_name: 'Marketing',
            display_name_synced_at: '2026-08-28T08:00:00.000Z',
            teams_app_id: 'app-xyz',
            installed_at: '2026-08-25T09:00:00.000Z',
            evidence: 'install_row',
          },
        ],
        capabilities: capabilities({ uninstall: true }),
      }),
    );
    const user = await renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    // Confirming a destructive action against a GUID alone asks the operator
    // to verify something they cannot read.
    expect(
      screen.getByText(
        "The orchestrator's app is removed from the team “Marketing” (team-abc) and stops answering there.",
      ),
    ).toBeTruthy();
  });

  it('uninstalls behind a confirm once the connector publishes one', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ capabilities: capabilities({ uninstall: true }) }),
    );
    mockUninstall.mockResolvedValue({
      ok: true,
      agent: 'odoo',
      team_id: 'team-abc',
      outcome: 'uninstalled',
      already_absent: false,
      state: 'catalog_uploaded',
    });
    const user = await renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    expect(mockUninstall).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockUninstall).toHaveBeenCalledWith('odoo', 'team-abc'));
    expect(await screen.findByText('Removed the app from team team-abc.')).toBeTruthy();
    // The capability is on, so no disabled-reason note is rendered with it.
    expect(screen.queryByText(/upgrade the plugin/)).toBeNull();
  });

  it('reports the idempotent already-absent removal as its own outcome (#900)', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ capabilities: capabilities({ uninstall: true }) }),
    );
    mockUninstall.mockResolvedValue({
      ok: true,
      agent: 'odoo',
      team_id: 'team-abc',
      outcome: 'already-absent',
      already_absent: true,
      state: 'catalog_uploaded',
    });
    const user = await renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockUninstall).toHaveBeenCalledWith('odoo', 'team-abc'));
    // Saying "removed" here would claim an action that did not happen: the
    // app was not in the team, only the record was stale.
    expect(
      await screen.findByText(
        'The app was not installed in team team-abc — the assignment has been cleared.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Removed the app from team team-abc.')).toBeNull();
  });

  it('localizes a 501 from a too-old connector instead of showing the raw body', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ capabilities: capabilities({ uninstall: true }) }),
    );
    mockUninstall.mockRejectedValue(
      new ApiError(501, 'Not Implemented', '{"error":"teams_uninstall_unsupported"}'),
    );
    const user = await renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(
      await screen.findByText(
        'The Microsoft 365 connector installed here is too old to remove an app from a team. Upgrade it to 0.4.0 or newer, or have a Teams administrator remove the app manually.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/teams_uninstall_unsupported/)).toBeNull();
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
        pending_target_kind: 'group-chat',
        running: true,
      }),
    );
    await renderPanel();

    expect(
      await screen.findByText(
        'A provisioning run targets Group chat team-pending. It only counts as installed once the chain reaches the install step.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("This orchestrator's app is not installed in any team yet."),
    ).toBeTruthy();
  });

  it('refuses to offer an install while a run is still targeting another team', async () => {
    // `teams` is EMPTY for every state but `installed`, so gating on
    // `installed.length` alone leaves the whole in-flight window open. The
    // route's non-installed branch does not 409 on state: it would overwrite
    // the only `team_id` column and enqueue a second run, while run #1 still
    // installs into the original team — an install nothing records and no
    // uninstall can remove.
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [],
        state: 'catalog_uploaded',
        pending_team_id: 'team-a',
        running: true,
      }),
    );
    await renderPanel();

    expect(screen.getByLabelText('Target ID')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Install' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('does not claim a run is under way for a chain that already stopped', async () => {
    // `pending_team_id` is set for EVERY non-installed state, terminal
    // failures included. Only `running` separates "still working on it" from
    // "stopped here", and this panel renders neither state nor last_error, so
    // nothing else on it would contradict a false claim.
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [],
        state: 'failed',
        pending_team_id: 'team-x',
        running: false,
        last_error: 'catalog upload rejected',
      }),
    );
    await renderPanel();

    expect(
      await screen.findByText(/no provisioning run is active/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/A provisioning run targets .* team-x/),
    ).toBeNull();
  });
});

/**
 * The two inputs an operator cannot submit, and the one they can.
 *
 * THE FIELD TEST. Someone pasted `abc8af8ec7fc471785d3b83c4d84b667` into a
 * field labelled "Team ID". The chain answered `400 teamId needs to be a valid
 * GUID`, then — once hyphenated — `404 No team found with Group Id`, after an
 * Entra app, an Azure bot and a catalog upload had all succeeded. Every one of
 * those answers arrived too late to help. These tests pin the answers arriving
 * BEFORE the button can be pressed.
 */
describe('AgentTeamsInstalls — install target classification', () => {
  it('names a team id as a team and enables Install', async () => {
    mockGetAgentTeams.mockResolvedValue(view({ teams: [] }));
    const user = await renderPanel();

    await user.type(
      await screen.findByLabelText('Target ID'),
      '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
    );

    expect(await screen.findByText('Detected as: Team')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('names a group chat id as a group chat and enables Install', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ teams: [], capabilities: capabilities({ chat_install: true }) }),
    );
    const user = await renderPanel();

    await user.type(
      await screen.findByLabelText('Target ID'),
      '19:abc123@thread.v2',
    );

    expect(await screen.findByText('Detected as: Group chat')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('refuses a CHANNEL id and says what to use instead', async () => {
    mockGetAgentTeams.mockResolvedValue(view({ teams: [] }));
    const user = await renderPanel();

    await user.type(
      await screen.findByLabelText('Target ID'),
      '19:aBcDeF@thread.tacv2',
    );

    // Names the mistake AND the way out — a channel has a parent team, and
    // that team's group id is the thing that works.
    expect(
      await screen.findByText(/channel id, not an install target/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('refuses a bare 32-hex id and offers BOTH readings as one click each', async () => {
    mockGetAgentTeams.mockResolvedValue(view({ teams: [] }));
    const user = await renderPanel();

    const field = await screen.findByLabelText('Target ID');
    await user.type(field, 'abc8af8ec7fc471785d3b83c4d84b667');

    expect(await screen.findByText(/32 hex characters with no context/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // The way out is a click, not a re-typing exercise: choosing "team"
    // rewrites the field to the hyphenated GUID and unblocks Install.
    await user.click(screen.getByRole('button', { name: 'Use as team' }));
    expect((field as HTMLInputElement).value).toBe(
      'abc8af8e-c7fc-4717-85d3-b83c4d84b667',
    );
    expect(await screen.findByText('Detected as: Team')).toBeTruthy();
  });

  it('offers the group-chat reading of that same id', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({ teams: [], capabilities: capabilities({ chat_install: true }) }),
    );
    const user = await renderPanel();

    const field = await screen.findByLabelText('Target ID');
    await user.type(field, 'abc8af8ec7fc471785d3b83c4d84b667');
    await user.click(screen.getByRole('button', { name: 'Use as group chat' }));

    // The full form the connector requires — it rejects a bare stem.
    expect((field as HTMLInputElement).value).toBe(
      '19:abc8af8ec7fc471785d3b83c4d84b667@thread.v2',
    );
    expect(await screen.findByText('Detected as: Group chat')).toBeTruthy();
  });

  it('refuses an unusable string without offering a guess', async () => {
    mockGetAgentTeams.mockResolvedValue(view({ teams: [] }));
    const user = await renderPanel();

    await user.type(await screen.findByLabelText('Target ID'), 'marketing team');

    expect(
      await screen.findByText(/not a Teams install target/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('warns about an old connector only once a CHAT is actually typed', async () => {
    // A deployment that installs into teams all day has no reason to be told
    // about a connector version it does not need.
    mockGetAgentTeams.mockResolvedValue(
      view({ teams: [], capabilities: capabilities({ chat_install: false }) }),
    );
    const user = await renderPanel();

    const field = await screen.findByLabelText('Target ID');
    await user.type(field, '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
    expect(screen.queryByText(/needs the Microsoft 365 connector 0.7.0/)).toBeNull();

    await user.clear(field);
    await user.type(field, '19:abc123@thread.v2');
    expect(
      await screen.findByText(/needs the Microsoft 365 connector 0.7.0/),
    ).toBeTruthy();
  });

  it('labels an installed CHAT as a chat, not as a team', async () => {
    mockGetAgentTeams.mockResolvedValue(
      view({
        teams: [
          {
            team_id: '19:abc123@thread.v2',
            target_kind: 'group-chat',
            team_display_name: null,
            teams_app_id: 'catalog-1',
            installed_at: null,
            evidence: 'install_row',
          },
        ],
      }),
    );
    await renderPanel();

    expect(await screen.findByText('Group chat')).toBeTruthy();
    // A nameless CHAT is not a failed lookup: the connector publishes no name
    // lookup for chats, and saying "could not resolve" would send an operator
    // chasing a connector bug that does not exist.
    expect(
      screen.getByText(/connector provides no name for chats/),
    ).toBeTruthy();
  });
});
