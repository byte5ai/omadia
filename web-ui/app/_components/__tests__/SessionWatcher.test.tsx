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

const { mockUsePathname, mockGetSessionStatus } = vi.hoisted(() => ({
  mockUsePathname: vi.fn(() => '/'),
  mockGetSessionStatus: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));
vi.mock('../../_lib/api', () => ({ getSessionStatus: mockGetSessionStatus }));

const WARNING_TITLE = 'Sitzung läuft bald ab';
const EXPIRED_TITLE = 'Sitzung abgelaufen';

/**
 * Make getSessionStatus behave like the real endpoint: a FIXED absolute
 * expiry, with `serverNow` tracking the (faked) wall clock so the
 * skew-correction nets to ~0 as time advances.
 */
function mockAuthedSession(expiresInSeconds: number): void {
  const expiresAtSec = Math.floor(Date.now() / 1000) + expiresInSeconds;
  mockGetSessionStatus.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      user: null,
      expiresAt: expiresAtSec,
      serverNow: Math.floor(Date.now() / 1000),
    }),
  );
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

  it('renders nothing and never probes on the /login page', async () => {
    mockUsePathname.mockReturnValue('/login');
    mockAuthedSession(2 * 60);
    const { container } = renderWithIntl(<SessionWatcher />, { locale: 'de' });
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(mockGetSessionStatus).not.toHaveBeenCalled();
  });
});
