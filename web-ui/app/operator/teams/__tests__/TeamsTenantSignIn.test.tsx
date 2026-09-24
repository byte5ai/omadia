import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { TeamsTenantSignIn } from '../_components/TeamsTenantSignIn';

/**
 * The tenant Teams sign-in panel (byte5ai/omadia#924).
 *
 * What these pin, beyond "it renders":
 *
 *   - THE CODE AND THE CONSENT URL ARE BOTH ON SCREEN WHILE THE FLOW RUNS.
 *     The code is what the admin types; the consent URL is what saves them when
 *     the sign-in page demands approval first. An admin who meets that prompt
 *     without the link is stuck with no way forward, and no error will ever
 *     tell them so — which is why the link must be there BEFORE anything fails.
 *   - `declined` IS NOT RENDERED AS "THE ADMIN CANCELLED". Microsoft returns
 *     that verdict for Conditional Access blocks too. The copy stays neutral
 *     and the server's `reason` is shown, because that string is the only
 *     thing that tells the two cases apart.
 *   - `accessTokenStale` IS NOT AN ERROR. The refresh token outlives the
 *     access token; showing it as a failure would send an operator to fix
 *     something that fixes itself on the next upload.
 *   - A CONNECTOR TOO OLD IS AN UPGRADE, not a missing install — a different
 *     sentence and a different action.
 *   - NO SECRET IS EVER RENDERED. The panel has no access to one by
 *     construction; this asserts the construction holds.
 */

const { mockStatus, mockStart, mockPoll, mockRevoke } = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockStart: vi.fn(),
  mockPoll: vi.fn(),
  mockRevoke: vi.fn(),
}));

// Spread the real module so the parsers and `secondsRemaining` — the shared
// contracts this panel renders from — stay genuine; only the four calls are
// stubbed.
vi.mock('../../../_lib/teamsSignIn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/teamsSignIn')>()),
  getTeamsSignInStatus: mockStatus,
  startTeamsSignIn: mockStart,
  pollTeamsSignIn: mockPoll,
  revokeTeamsSignIn: mockRevoke,
}));

const CONSENT_URL = 'https://login.microsoftonline.com/tenant-1/adminconsent';

function signedOut(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    signIn: {
      signedIn: false,
      signedInAt: null,
      expiresAt: null,
      accessTokenStale: false,
      scopes: [],
      tenantId: null,
      account: null,
    },
    pending: null,
    ...overrides,
  };
}

function pendingFlow(overrides: Record<string, unknown> = {}) {
  return {
    userCode: 'GH7K-QW2P',
    verificationUri: 'https://microsoft.com/devicelogin',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    intervalSeconds: 5,
    scopes: ['AppCatalog.Submit'],
    adminConsentUrl: CONSENT_URL,
    ...overrides,
  };
}

function signedIn(overrides: Record<string, unknown> = {}) {
  return {
    signedIn: true,
    signedInAt: '2026-08-01T09:00:00.000Z',
    expiresAt: '2026-08-28T18:00:00.000Z',
    accessTokenStale: false,
    scopes: ['AppCatalog.Submit'],
    tenantId: 'tenant-1',
    account: { username: 'admin@contoso.test', displayName: 'Ada Admin' },
    ...overrides,
  };
}

beforeEach(() => {
  mockStatus.mockReset();
  mockStart.mockReset();
  mockPoll.mockReset();
  mockRevoke.mockReset();
  mockPoll.mockResolvedValue({ status: 'pending', retryAfterSeconds: 5 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TeamsTenantSignIn — signed out', () => {
  it('explains WHY this step exists before asking for anything', async () => {
    mockStatus.mockResolvedValue(signedOut());
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-signed-out');
    // An operator who does not know that Microsoft refuses app-only catalogue
    // uploads reads this whole screen as bureaucracy.
    expect(screen.getByText(/nur im Namen einer angemeldeten Person/i)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Anmeldung starten/i }),
    ).toBeTruthy();
  });

  it('says "upgrade", not "install", when the connector is too old', async () => {
    mockStatus.mockResolvedValue(signedOut({ supported: false }));
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    const notice = await screen.findByTestId('teams-sign-in-unsupported');
    expect(notice.textContent).toMatch(/0\.6\.0/);
    expect(notice.textContent).toMatch(/bereits/i);
    // The button would answer 503 — offering it would be a lie about the state.
    expect(
      screen.getByRole('button', { name: /Anmeldung starten/i }),
    ).toHaveProperty('disabled', true);
  });
});

describe('TeamsTenantSignIn — flow running', () => {
  it('shows the code, the verification link AND the consent URL together', async () => {
    mockStatus.mockResolvedValue(signedOut());
    mockStart.mockResolvedValue(pendingFlow());
    const user = userEvent.setup();
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-signed-out');
    await user.click(screen.getByRole('button', { name: /Anmeldung starten/i }));

    const code = await screen.findByTestId('teams-user-code');
    expect(code.textContent).toBe('GH7K-QW2P');

    expect(
      screen.getByTestId('teams-verification-link').getAttribute('href'),
    ).toBe('https://microsoft.com/devicelogin');

    // THE dead-end guard: present while the flow runs, not only after a
    // failure. Without it, an admin who meets a consent prompt cannot continue.
    const consent = screen.getByTestId('teams-consent-link');
    expect(consent.getAttribute('href')).toBe(CONSENT_URL);
  });

  it('renders a live countdown so the panel is visibly alive between polls', async () => {
    mockStatus.mockResolvedValue(
      signedOut({ pending: pendingFlow({ expiresAt: new Date(Date.now() + 120_000).toISOString() }) }),
    );
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    const countdown = await screen.findByTestId('teams-code-countdown');
    expect(countdown.textContent).toMatch(/\d+ Sekunden/);
  });

  it('a flow already running on the server comes back after a page reload', async () => {
    // The operator refreshed mid-sign-in. Making them start over would waste a
    // code that is still perfectly valid.
    mockStatus.mockResolvedValue(signedOut({ pending: pendingFlow() }));
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    expect((await screen.findByTestId('teams-user-code')).textContent).toBe(
      'GH7K-QW2P',
    );
    expect(mockStart).not.toHaveBeenCalled();
  });

  // A flow missing its verification target is dropped at the BOUNDARY, not
  // here — `parsePendingFlow` owns that, and it is asserted in
  // `app/_lib/__tests__/teamsSignIn.test.ts`. Asserting it through a mocked
  // `getTeamsSignInStatus` would have proved nothing: the mock replaces the
  // very parser under test.
});

describe('TeamsTenantSignIn — terminal verdicts', () => {
  it('renders `declined` WITHOUT blaming the admin, and shows the reason', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockStatus.mockResolvedValue(signedOut({ pending: pendingFlow() }));
    mockPoll.mockResolvedValue({
      status: 'declined',
      reason: 'AADSTS53003: blocked by a Conditional Access policy',
    });
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-user-code');
    await vi.advanceTimersByTimeAsync(6000);

    const notice = await screen.findByTestId('teams-sign-in-declined');
    // Neutral copy: a policy block reaches this same branch.
    expect(notice.textContent).toMatch(/nicht abgeschlossen/i);
    expect(notice.textContent).not.toMatch(/abgebrochen von|hat abgebrochen/i);
    // The one string that tells cancel and policy apart must be visible.
    expect(notice.textContent).toMatch(/Conditional Access/);
  });

  it('renders `expired` as a harmless restart, not a failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockStatus.mockResolvedValue(signedOut({ pending: pendingFlow() }));
    mockPoll.mockResolvedValue({ status: 'expired', reason: null });
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-user-code');
    await vi.advanceTimersByTimeAsync(6000);

    const notice = await screen.findByTestId('teams-sign-in-expired');
    expect(notice.textContent).toMatch(/nichts angelegt|nichts verändert/i);
    // Back to a usable state rather than a dead panel.
    await screen.findByTestId('teams-signed-out');
  });
});

describe('TeamsTenantSignIn — signed in', () => {
  it('shows who and since when, and leads with the durable truth', async () => {
    mockStatus.mockResolvedValue(signedOut({ signIn: signedIn() }));
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    const panel = await screen.findByTestId('teams-signed-in');
    expect(panel.textContent).toMatch(/Ada Admin/);
    expect(panel.textContent).toMatch(/Angemeldet seit/);
    expect(screen.getByRole('button', { name: /Abmelden/i })).toBeTruthy();

    // THE HEADLINE, and the reason it is one: the panel used to put the
    // access token's expiry beside "signed in since", and operators read the
    // pair as a one-hour session. It is not — Microsoft fixes that lifetime
    // and the refresh token behind it lasts weeks.
    const headline = await screen.findByTestId('teams-sign-in-self-renewing');
    expect(headline.textContent).toMatch(/erneuert sich selbst/i);
  });

  it('keeps the access-token expiry as a technical detail, not a countdown', async () => {
    mockStatus.mockResolvedValue(signedOut({ signIn: signedIn() }));
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    const panel = await screen.findByTestId('teams-signed-in');
    // Still available — it is genuinely useful in a support conversation.
    expect(panel.textContent).toMatch(/Aktuelles Zugriffstoken gültig bis/);
    // But behind a disclosure, and next to the sentence that says the number
    // means nothing for the sign-in.
    const details = panel.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.textContent).toMatch(/Aktuelles Zugriffstoken gültig bis/);
    expect(details?.textContent).toMatch(/gibt Microsoft vor/);
  });

  it('a stale access token is a neutral note, never an alert', async () => {
    mockStatus.mockResolvedValue(
      signedOut({ signIn: signedIn({ accessTokenStale: true }) }),
    );
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    // Still signed in — this is the assertion the whole field exists for.
    await screen.findByTestId('teams-signed-in');
    const note = screen.getByTestId('teams-token-stale');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toMatch(/kein Fehler/i);
    // Not an alert anywhere on the page.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signing out returns the panel to the signed-out state', async () => {
    mockStatus.mockResolvedValue(signedOut({ signIn: signedIn() }));
    mockRevoke.mockResolvedValue(signedOut());
    const user = userEvent.setup();
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-signed-in');
    await user.click(screen.getByRole('button', { name: /Abmelden/i }));

    await waitFor(() => {
      expect(screen.getByTestId('teams-signed-out')).toBeTruthy();
    });
    expect(mockRevoke).toHaveBeenCalledOnce();
  });
});

describe('TeamsTenantSignIn — nothing secret is rendered', () => {
  it('polls without arguments, so no device code can pass through the client', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockStatus.mockResolvedValue(signedOut({ pending: pendingFlow() }));
    renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-user-code');
    await vi.advanceTimersByTimeAsync(6000);

    await waitFor(() => {
      expect(mockPoll).toHaveBeenCalled();
    });
    // The whole point of holding the handle server-side: the client has no
    // argument to leak, replay or put in a URL.
    for (const call of mockPoll.mock.calls) {
      expect(call).toHaveLength(0);
    }
  });

  it('a token smuggled into the payload is dropped by the parser, not displayed', async () => {
    // A hostile or buggy middleware. The parser is an allow-list, so extra
    // fields never reach the render — this asserts that end to end.
    mockStatus.mockResolvedValue({
      supported: true,
      signIn: { ...signedIn(), accessToken: 'SENTINEL-LEAK-1234' },
      pending: { ...pendingFlow(), flowHandle: 'SENTINEL-HANDLE-5678' },
    });
    const { container } = renderWithIntl(<TeamsTenantSignIn />, { locale: 'de' });

    await screen.findByTestId('teams-user-code');
    expect(container.innerHTML).not.toContain('SENTINEL-LEAK-1234');
    expect(container.innerHTML).not.toContain('SENTINEL-HANDLE-5678');
  });
});
