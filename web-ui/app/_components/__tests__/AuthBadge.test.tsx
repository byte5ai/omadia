import type { ReactNode } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import { AuthBadge } from '../AuthBadge';

/**
 * Sign-out from the header menu. The middleware answers 503
 * `auth.logout_revocation_failed` when it could not end the session, and
 * keeps the cookie. The badge must then say the user is still signed in and
 * offer the same request again, never land on /login as if it had worked.
 */

const { mockGetAuthMe, mockPostAuthLogout } = vi.hoisted(() => ({
  mockGetAuthMe: vi.fn(),
  mockPostAuthLogout: vi.fn(),
}));

// Keep the real ApiError (its `code` comes from the JSON body); stub the calls.
vi.mock('../../_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/api')>();
  return { ...actual, getAuthMe: mockGetAuthMe, postAuthLogout: mockPostAuthLogout };
});

// The menu is wrapped in AnimatePresence; render its children directly so
// the assertions do not depend on the animation frame loop.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children?: ReactNode }) => children ?? null,
  };
});

let restoreLocation: (() => void) | null = null;

/** jsdom drops `location.href = …`; a plain object makes it observable. */
function stubLocation(): { href: string } {
  const realLocation = window.location;
  const stub = { href: 'http://localhost:3000/chat' };
  Object.defineProperty(window, 'location', { configurable: true, value: stub });
  restoreLocation = () =>
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  return stub;
}

function revocationFailed(): ApiError {
  return new ApiError(
    503,
    'HTTP 503',
    JSON.stringify({ code: 'auth.logout_revocation_failed', message: 'raw server text' }),
  );
}

async function openMenu(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Operator/ }));
}

beforeEach(() => {
  mockGetAuthMe.mockResolvedValue({
    user: { email: 'operator@example.com', display_name: 'Operator', role: 'admin' },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
});

afterEach(() => {
  restoreLocation?.();
  restoreLocation = null;
  vi.clearAllMocks();
});

describe('<AuthBadge /> sign-out', () => {
  it('lands on /login once the server confirms the sign-out', async () => {
    mockPostAuthLogout.mockResolvedValue({ ok: true, logout_urls: [] });
    renderWithIntl(<AuthBadge />);
    await openMenu();
    const location = stubLocation();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    await waitFor(() => expect(location.href).toBe('/login'));
  });

  it('says the user is still signed in when the server could not end the session', async () => {
    mockPostAuthLogout.mockRejectedValue(revocationFailed());
    renderWithIntl(<AuthBadge />);
    await openMenu();
    const location = stubLocation();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You are still signed in.');
    expect(alert.textContent).toContain('Try signing out again in a moment.');
    expect(alert.textContent).not.toContain('raw server text');
    expect(location.href).toBe('http://localhost:3000/chat');
  });

  it('offers the retry, and a retry that succeeds signs out', async () => {
    mockPostAuthLogout
      .mockRejectedValueOnce(revocationFailed())
      .mockResolvedValueOnce({ ok: true, logout_urls: [] });
    renderWithIntl(<AuthBadge />);
    await openMenu();
    const location = stubLocation();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    const retry = await screen.findByRole('button', { name: /Try signing out again/ });
    fireEvent.click(retry);

    await waitFor(() => expect(location.href).toBe('/login'));
    expect(mockPostAuthLogout).toHaveBeenCalledTimes(2);
  });

  it('shows the German copy under the de locale', async () => {
    mockPostAuthLogout.mockRejectedValue(revocationFailed());
    renderWithIntl(<AuthBadge />, { locale: 'de' });
    await openMenu();
    stubLocation();
    fireEvent.click(screen.getByRole('button', { name: /Abmelden/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Du bist noch angemeldet.');
    expect(screen.getByRole('button', { name: /Erneut abmelden/ })).toBeTruthy();
  });

  it('a request that got no answer is shown as a failure too, not as a sign-out', async () => {
    mockPostAuthLogout.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWithIntl(<AuthBadge />);
    await openMenu();
    const location = stubLocation();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sign-out did not go through. You are still signed in.');
    expect(location.href).toBe('http://localhost:3000/chat');
  });
});
