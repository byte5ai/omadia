import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import LoginPage from '../page';

/**
 * Coverage for the /login redirect path: an already-authenticated visitor
 * is bounced to the sanitised returnPath, and the ?return=/login loop is
 * short-circuited to '/'.
 */

const {
  mockReplace,
  mockSearchParamsGet,
  mockGetSessionStatus,
  mockGetAuthProviders,
  mockPostAuthLogin,
} = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockSearchParamsGet: vi.fn<(key: string) => string | null>(() => null),
  mockGetSessionStatus: vi.fn(),
  mockGetAuthProviders: vi.fn(),
  mockPostAuthLogin: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

vi.mock('../../_lib/api', () => ({
  // Mirrors the real ApiError: the machine code is parsed out of the body.
  ApiError: class ApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      let code: string | null = null;
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        code = typeof parsed.code === 'string' ? parsed.code : null;
      } catch {
        code = null;
      }
      this.code = code;
    }
  },
  getSessionStatus: mockGetSessionStatus,
  getAuthProviders: mockGetAuthProviders,
  postAuthLogin: mockPostAuthLogin,
}));

function authedSession() {
  return Promise.resolve({
    authenticated: true,
    user: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    serverNow: Math.floor(Date.now() / 1000),
  });
}

function unauthedSession() {
  return Promise.resolve({
    authenticated: false,
    user: null,
    expiresAt: null,
    serverNow: null,
  });
}

function noProviders() {
  return Promise.resolve({ providers: [], setup_required: false, setup_token_required: false });
}

beforeEach(() => {
  mockSearchParamsGet.mockReturnValue(null);
  mockGetAuthProviders.mockImplementation(noProviders);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<LoginPage /> redirect on mount', () => {
  it('redirects an authenticated visitor to returnPath', async () => {
    mockSearchParamsGet.mockReturnValue('/some/page');
    mockGetSessionStatus.mockImplementation(authedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/some/page'),
    );
  });

  it("guards against ?return=/login by redirecting to '/' instead", async () => {
    mockSearchParamsGet.mockReturnValue('/login');
    mockGetSessionStatus.mockImplementation(authedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it("defaults returnPath to '/' when no ?return is given", async () => {
    mockSearchParamsGet.mockReturnValue(null);
    mockGetSessionStatus.mockImplementation(authedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('does not redirect on an explicit ?reauth=1 even when still authenticated', async () => {
    // The "Relogin now" button lands here with a live session; the page
    // must show the form instead of bouncing back (issue #412).
    mockSearchParamsGet.mockImplementation((key) =>
      key === 'reauth' ? '1' : key === 'return' ? '/chat' : null,
    );
    mockGetSessionStatus.mockImplementation(authedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() => expect(mockGetAuthProviders).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not redirect an unauthenticated visitor', async () => {
    mockSearchParamsGet.mockReturnValue(null);
    mockGetSessionStatus.mockImplementation(unauthedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('probes session and providers in parallel', async () => {
    mockSearchParamsGet.mockReturnValue(null);
    mockGetSessionStatus.mockImplementation(unauthedSession);

    renderWithIntl(<LoginPage />);

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetAuthProviders).toHaveBeenCalled();
    });
  });
});

describe('<LoginPage /> sign-in errors', () => {
  function passwordProvider() {
    return Promise.resolve({
      providers: [{ id: 'local', displayName: 'Email & Password', kind: 'password' }],
      setup_required: false,
      setup_token_required: false,
    });
  }

  async function submit(): Promise<void> {
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  }

  beforeEach(() => {
    mockGetSessionStatus.mockImplementation(unauthedSession);
    mockGetAuthProviders.mockImplementation(passwordProvider);
  });

  it('shows the localized message, not the raw error, when sign-in is rate-limited', async () => {
    const { ApiError } = await import('../../_lib/api');
    mockPostAuthLogin.mockRejectedValue(
      new ApiError(
        429,
        'POST /v1/auth/login/local → 429',
        JSON.stringify({ code: 'auth.rate_limited', retry_after_s: 7 }),
      ),
    );
    renderWithIntl(<LoginPage />);
    await submit();
    expect(
      await screen.findByText('Too many sign-in attempts. Please wait 7 seconds and try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/→ 429/)).toBeNull();
  });

  it('treats a busy server (503 auth.busy) the same way', async () => {
    const { ApiError } = await import('../../_lib/api');
    mockPostAuthLogin.mockRejectedValue(
      new ApiError(
        503,
        'POST /v1/auth/login/local → 503',
        JSON.stringify({ code: 'auth.busy', retry_after_s: 1 }),
      ),
    );
    renderWithIntl(<LoginPage />, { locale: 'de' });
    fireEvent.change(await screen.findByLabelText('E-Mail'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(
      await screen.findByText(
        'Zu viele Anmeldeversuche. Bitte 1 Sekunde warten und erneut versuchen.',
      ),
    ).toBeTruthy();
  });

  it('keeps the incorrect-credentials message for a 401', async () => {
    const { ApiError } = await import('../../_lib/api');
    mockPostAuthLogin.mockRejectedValue(
      new ApiError(401, 'POST /v1/auth/login/local → 401', '{"code":"auth.invalid_credentials"}'),
    );
    renderWithIntl(<LoginPage />);
    await submit();
    expect(await screen.findByText('Incorrect email or password.')).toBeTruthy();
  });
});
