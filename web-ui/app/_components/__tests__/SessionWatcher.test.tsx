import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { SessionWatcher } from '../SessionWatcher';

/**
 * Deterministic coverage for the SessionWatcher time-state-machine:
 * normal → warning → expired, plus the heartbeat-detected revocation
 * path and the /login no-op guard. Fake timers stand in for the real
 * 4h clock so the transitions are testable in milliseconds.
 */

const { mockUsePathname, mockGetSessionStatus, mockRenewSession } = vi.hoisted(
  () => ({
    mockUsePathname: vi.fn(() => '/'),
    mockGetSessionStatus: vi.fn(),
    mockRenewSession: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));
vi.mock('../../_lib/api', () => ({
  getSessionStatus: mockGetSessionStatus,
  renewSession: mockRenewSession,
}));

const WARNING_TITLE = 'Sitzung läuft bald ab';
const EXPIRED_TITLE = 'Sitzung abgelaufen';
const STILL_HERE = 'Ich bin noch da';
const SIGN_IN_AGAIN = 'Neu anmelden';
const SIGN_IN_NOW = 'Jetzt neu anmelden';
const RETRY = 'Erneut versuchen';
const HOUR_S = 60 * 60;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Make getSessionStatus behave like the real endpoint: a FIXED absolute
 * expiry, with `serverNow` tracking the (faked) wall clock so the
 * skew-correction nets to ~0 as time advances. `renewableUntil` defaults
 * to a cap far away, i.e. "renewal possible".
 */
function mockAuthedSession(
  expiresInSeconds: number,
  renewableUntil: number | null = nowSec() + 12 * HOUR_S,
): void {
  const expiresAtSec = nowSec() + expiresInSeconds;
  mockGetSessionStatus.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      user: null,
      expiresAt: expiresAtSec,
      serverNow: nowSec(),
      renewableUntil,
    }),
  );
}

/** jsdom's location.assign is non-configurable, so swap the whole object. */
function stubLocation(): { assign: ReturnType<typeof vi.fn>; restore: () => void } {
  const assign = vi.fn();
  const realLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: '/chat', search: '?thread=42', assign },
  });
  return {
    assign,
    restore: () =>
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: realLocation,
      }),
  };
}

function expectReloginTo(assign: ReturnType<typeof vi.fn>): void {
  expect(assign).toHaveBeenCalledTimes(1);
  const url = new URL(assign.mock.calls[0]?.[0] as string, 'http://localhost');
  expect(url.pathname).toBe('/login');
  expect(url.searchParams.get('reauth')).toBe('1');
  expect(url.searchParams.get('return')).toBe('/chat?thread=42');
}

async function click(name: string): Promise<void> {
  const button = screen.getByRole('button', { name });
  await act(async () => {
    button.click();
  });
}

/** Advance fake time AND flush the probe's pending promises. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
  mockUsePathname.mockReturnValue('/');
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('<SessionWatcher />', () => {
  it('renders no dialog while the session is comfortably valid', async () => {
    mockAuthedSession(60 * 60); // 1h left
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    expect(screen.queryByText(WARNING_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();
  });

  it('shows the warning card immediately when loaded inside the warn window', async () => {
    mockAuthedSession(2 * 60); // 2 min left — inside the 5-min warn window
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    expect(screen.getByText(WARNING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();
  });

  it('schedules the warning, then the expiry overlay, as time advances', async () => {
    mockAuthedSession(6 * 60); // warn fires at +1min, expiry at +6min
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();
    expect(screen.queryByText(WARNING_TITLE)).not.toBeInTheDocument();

    await flush(61_000); // cross the warn threshold
    expect(screen.getByText(WARNING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();

    await flush(5 * 60_000); // reach expiry
    expect(screen.getByText(EXPIRED_TITLE)).toBeInTheDocument();
  });

  it('jumps straight to the expired overlay when the heartbeat sees no session', async () => {
    mockGetSessionStatus.mockResolvedValue({
      authenticated: false,
      user: null,
      expiresAt: null,
      serverNow: null,
    });
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(EXPIRED_TITLE)).toBeInTheDocument();
  });

  it('"I\'m still here" renews in place: card goes, no navigation, timers re-arm (#965)', async () => {
    const loc = stubLocation();
    try {
      mockAuthedSession(2 * 60); // inside the warn window
      mockRenewSession.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          expiresAt: nowSec() + 4 * HOUR_S,
          serverNow: nowSec(),
          renewableUntil: nowSec() + 12 * HOUR_S,
        }),
      );
      renderWithIntl(<SessionWatcher />, { locale: 'de' });
      await flush();
      expect(screen.getByText(WARNING_TITLE)).toBeInTheDocument();

      await click(STILL_HERE);
      await flush(1_000); // renew resolves + the card's exit animation ends

      expect(mockRenewSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(WARNING_TITLE)).not.toBeInTheDocument();
      expect(loc.assign).not.toHaveBeenCalled();

      // Past the OLD expiry: no overlay. The (stale) heartbeat still reports
      // the old expiry — it must not shrink the renewed one.
      await flush(3 * 60_000);
      expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();
      expect(screen.queryByText(WARNING_TITLE)).not.toBeInTheDocument();

      // The warning comes back at the NEW T-5min (elapsed so far: 1s + 3min).
      await flush(4 * HOUR_S * 1000 - 5 * 60_000 - 3 * 60_000);
      expect(screen.getByText(WARNING_TITLE)).toBeInTheDocument();
      expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();
    } finally {
      loc.restore();
    }
  });

  it('a refused renewal falls back to re-login with the reauth flag (#412, #965)', async () => {
    // The current session is still valid during the warning phase, so the
    // reauth flag is what stops /login from bouncing straight back (#412).
    const loc = stubLocation();
    try {
      mockAuthedSession(2 * 60);
      mockRenewSession.mockResolvedValue({
        ok: false,
        kind: 'refused',
        code: 'auth.renew_expired',
      });
      renderWithIntl(<SessionWatcher />, { locale: 'de' });
      await flush();

      await click(STILL_HERE);
      await flush();

      expect(screen.getByText(/lässt sich nicht weiter verlängern/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: STILL_HERE })).not.toBeInTheDocument();
      await click(SIGN_IN_AGAIN);
      expectReloginTo(loc.assign);
    } finally {
      loc.restore();
    }
  });

  it('a failed renewal keeps the card with a retry (#965)', async () => {
    mockAuthedSession(2 * 60);
    mockRenewSession.mockResolvedValue({ ok: false, kind: 'error' });
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    await click(STILL_HERE);
    await flush();
    expect(screen.getByText(/hat gerade nicht geklappt/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SIGN_IN_AGAIN })).toBeInTheDocument();

    await click(RETRY);
    await flush();
    expect(mockRenewSession).toHaveBeenCalledTimes(2);
  });

  it('offers only re-login in the final window before the cap (#965)', async () => {
    const loc = stubLocation();
    try {
      // exp sits exactly on renewable_until: nothing left to extend.
      mockAuthedSession(2 * 60, nowSec() + 2 * 60);
      renderWithIntl(<SessionWatcher />, { locale: 'de' });
      await flush();

      expect(screen.getByText(/maximale Dauer erreicht/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: STILL_HERE })).not.toBeInTheDocument();
      await click(SIGN_IN_NOW);
      expectReloginTo(loc.assign);
      expect(mockRenewSession).not.toHaveBeenCalled();
    } finally {
      loc.restore();
    }
  });

  it('treats a server without renewal (renewableUntil null) as the final window', async () => {
    mockAuthedSession(2 * 60, null);
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();
    expect(screen.getByRole('button', { name: SIGN_IN_NOW })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: STILL_HERE })).not.toBeInTheDocument();
  });

  it('drops a warning back to normal when another tab renewed (#965)', async () => {
    mockAuthedSession(2 * 60);
    renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();
    expect(screen.getByText(WARNING_TITLE)).toBeInTheDocument();

    // The next heartbeat sees an expiry pushed out by a renewal elsewhere.
    mockAuthedSession(4 * HOUR_S);
    await flush(60_000);
    await flush(1_000); // let the card's exit animation finish
    expect(screen.queryByText(WARNING_TITLE)).not.toBeInTheDocument();

    // …and the old expiry passes without an overlay.
    await flush(2 * 60_000);
    expect(screen.queryByText(EXPIRED_TITLE)).not.toBeInTheDocument();
  });

  it('the expired overlay still requires a real login', async () => {
    const loc = stubLocation();
    try {
      mockGetSessionStatus.mockResolvedValue({
        authenticated: false,
        user: null,
        expiresAt: null,
        serverNow: null,
        renewableUntil: null,
      });
      renderWithIntl(<SessionWatcher />, { locale: 'de' });
      await flush();

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: STILL_HERE })).not.toBeInTheDocument();
      await click(SIGN_IN_AGAIN);
      expectReloginTo(loc.assign);
      expect(mockRenewSession).not.toHaveBeenCalled();
    } finally {
      loc.restore();
    }
  });

  it('renders nothing and never probes on the /login page', async () => {
    mockUsePathname.mockReturnValue('/login');
    mockAuthedSession(2 * 60);
    const { container } = renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(mockGetSessionStatus).not.toHaveBeenCalled();
  });
});
