import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { TeamsIdentityStatusDto } from '../../../../_lib/agents';
import { AgentTeamsIdentity } from '../_components/AgentTeamsIdentity';

/**
 * The agent panel's half of byte5ai/omadia#924.
 *
 * The tenant sign-in lives on its own page; what the AGENT panel owes is
 * two things, and they are what these pin:
 *
 *   1. THE PACKAGE DOWNLOAD IS ALWAYS THERE. Not only after a failure — the
 *      package is a pure render of the identity, so gating it on an error
 *      state would hand it exclusively to operators already in trouble and
 *      hide it from the ones calmly preparing a rollout. The copy has to say
 *      it is a FALLBACK, or offering it quietly reinstates the per-agent
 *      manual upload this whole change removed.
 *
 *   2. THE FOUR DELEGATED FAILURES ARE FOUR DIFFERENT MESSAGES, and three of
 *      them link to the page that actually fixes them. A panel that says
 *      "sign in" without a link leaves the operator hunting for a screen they
 *      may not know exists; a panel that collapses the four leaves them
 *      guessing which of four unrelated actions to take.
 *
 * `device_code_flow_failed` deliberately does NOT get that link: no amount of
 * clicking "sign in" fixes a publisher app that refuses device-code flows.
 */

const { mockGet, mockProvision } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProvision: vi.fn(),
}));

// Spread the real module so the error-code parser and the `last_error_detail`
// narrower — the contracts this UI maps to catalogue keys — stay genuine.
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
    agent: 'hr',
    state: 'installed',
    running: false,
    provisioner_installed: true,
    identity: {
      bot_slug: 'hr',
      display_name: 'HR Bot',
      app_id: 'app-1',
      tenant_id: 'tenant-1',
      teams_app_id: 'teams-app-1',
      teams_app_external_id: 'external-1',
      team_id: 'team-1',
      last_error: null,
      last_error_detail: null,
      created_at: null,
      updated_at: null,
    },
    teams_bot: null,
    ...overrides,
  } as TeamsIdentityStatusDto;
}

/** A parked run: the state is real progress, the error explains the wait. */
function parked(
  code: string,
  detail: Record<string, unknown> = {},
): TeamsIdentityStatusDto {
  return statusDto({
    state: 'package_built',
    identity: {
      ...statusDto().identity,
      last_error: `${code}: something the operator has to do`,
      last_error_detail: {
        code,
        raw: `${code}: something the operator has to do`,
        ...detail,
      },
    },
  } as Partial<TeamsIdentityStatusDto>);
}

beforeEach(() => {
  mockGet.mockReset();
  mockProvision.mockReset();
});

describe('#924 the app package download', () => {
  it('is offered on a healthy, installed identity', async () => {
    mockGet.mockResolvedValue(statusDto());
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const link = await screen.findByTestId('teams-package-download');
    expect(link.getAttribute('href')).toBe(
      '/bot-api/v1/operator/agents/hr/teams-identity/package',
    );
    // A real download, not a fetch-and-blob: the route sets
    // Content-Disposition and the browser streams it under the right name.
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('presents itself as a FALLBACK, not as the normal path', async () => {
    mockGet.mockResolvedValue(statusDto());
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    await screen.findByTestId('teams-package-download');
    // If this copy ever goes missing, the panel silently reinstates the
    // per-agent manual upload that #924 exists to remove.
    expect(screen.getByText(/Rückfallebene/i)).toBeTruthy();
    expect(screen.getByText(/lädt dieses Paket selbst/i)).toBeTruthy();
  });

  it('escapes the slug it puts in the URL', async () => {
    mockGet.mockResolvedValue(statusDto({ agent: 'hr/../admin' }));
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const link = await screen.findByTestId('teams-package-download');
    expect(link.getAttribute('href')).toBe(
      '/bot-api/v1/operator/agents/hr%2F..%2Fadmin/teams-identity/package',
    );
  });
});

describe('#924 the four delegated failures each get their own message', () => {
  it('delegated_sign_in_required: says sign in, links the tenant page, and says nothing is broken', async () => {
    mockGet.mockResolvedValue(
      parked('delegated_sign_in_required', { scopes: ['AppCatalog.Submit'] }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/angemeldete Tenant-Administration/i);
    expect(alert.textContent).toMatch(/AppCatalog\.Submit/);
    // The link is what turns "sign in" from an instruction into an action.
    expect(
      screen.getByTestId('teams-tenant-sign-in-link').getAttribute('href'),
    ).toBe('/operator/teams');
  });

  it('delegated_consent_required: links the tenant CONSENT url, not documentation', async () => {
    const consentUrl = 'https://login.microsoftonline.com/tenant-1/adminconsent';
    mockGet.mockResolvedValue(
      parked('delegated_consent_required', {
        scopes: ['AppCatalog.Submit'],
        adminConsentUrl: consentUrl,
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/noch niemand zugestimmt/i);
    // The exact page an admin approves on — generic docs would not do.
    const links = Array.from(alert.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toContain(consentUrl);
  });

  it('a non-https consent URL never becomes a link', async () => {
    mockGet.mockResolvedValue(
      parked('delegated_consent_required', {
        adminConsentUrl: 'javascript:alert(1)',
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    const links = Array.from(alert.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(links.some((href) => href?.startsWith('javascript:'))).toBe(false);
  });

  it('delegated_token_expired: says sign in AGAIN, distinctly from never having signed in', async () => {
    mockGet.mockResolvedValue(parked('delegated_token_expired'));
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/nicht mehr gültig/i);
    expect(alert.textContent).toMatch(/erneut an/i);
    expect(screen.getByTestId('teams-tenant-sign-in-link')).toBeTruthy();
  });

  it('device_code_flow_failed: points at the publisher app, and does NOT offer a sign-in link', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        state: 'failed',
        identity: {
          ...statusDto().identity,
          last_error: 'device_code_flow_failed: [invalid_client] refused',
          last_error_detail: {
            code: 'device_code_flow_failed',
            reason: 'invalid_client',
            raw: 'device_code_flow_failed: [invalid_client] refused',
          },
        },
      } as Partial<TeamsIdentityStatusDto>),
    );
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Publisher-App/i);
    expect(alert.textContent).toMatch(/Conditional-Access/i);
    expect(alert.textContent).toMatch(/invalid_client/);
    // Clicking "sign in" cannot fix a publisher app — offering it would send
    // the operator round a loop that never resolves.
    expect(screen.queryByTestId('teams-tenant-sign-in-link')).toBeNull();
  });

  it('the four render four different explanations', async () => {
    const texts = new Set<string>();
    for (const code of [
      'delegated_sign_in_required',
      'delegated_consent_required',
      'delegated_token_expired',
      'device_code_flow_failed',
    ]) {
      mockGet.mockResolvedValue(parked(code));
      const { unmount } = renderWithIntl(<AgentTeamsIdentity slug="hr" />, {
        locale: 'de',
      });
      const alert = await screen.findByRole('alert');
      texts.add(alert.textContent ?? '');
      unmount();
    }
    expect(texts.size).toBe(4);
  });
});

describe('#924 a parked run is not presented as a failure', () => {
  it('keeps the reached state visible and says progress is kept', async () => {
    mockGet.mockResolvedValue(parked('delegated_sign_in_required'));
    renderWithIntl(<AgentTeamsIdentity slug="hr" />, { locale: 'de' });

    const alert = await screen.findByRole('alert');
    // The whole point of parking: the Entra app and the bot survive, so the
    // operator must not be told to clean anything up or start over.
    expect(alert.textContent).toMatch(/wartet/i);
    expect(alert.textContent).toMatch(/bleiben bestehen|weiter/i);
  });
});
