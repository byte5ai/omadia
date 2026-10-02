import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import LoginPage from '../page';

/**
 * Coverage for the /login redirect path: an already-authenticated visitor
 * is bounced to returnPath as sanitised by `_lib/returnPath.ts`, and the
 * ?return=/login loop is short-circuited to '/'. The second block feeds a
 * crafted ?return= to every navigation sink on the page.
 */

const {
  mockReplace,
  mockRouter,
  mockSearchParamsGet,
  mockGetSessionStatus,
  mockGetAuthProviders,
  mockPostAuthLogin,
} = vi.hoisted(() => {
  const replace = vi.fn();
  return {
    mockReplace: replace,
    // Stable across renders, like Next's own router. A fresh object per
    // render would re-run the page's mount effect on every re-render.
    mockRouter: { replace },
    mockSearchParamsGet: vi.fn<(key: string) => string | null>(() => null),
    mockGetSessionStatus: vi.fn(),
    mockGetAuthProviders: vi.fn(),
    mockPostAuthLogin: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
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

function passwordProvider() {
  return Promise.resolve({
    providers: [{ id: 'local', kind: 'password', displayName: 'Password' }],
    setup_required: false,
  });
}

function oidcProvider() {
  return Promise.resolve({
    providers: [{ id: 'entra', kind: 'oidc', displayName: 'Microsoft' }],
    setup_required: false,
  });
}

function setupRequired() {
  return Promise.resolve({ providers: [], setup_required: true });
}

function givenReturn(value: string): void {
  mockSearchParamsGet.mockImplementation((key) => (key === 'return' ? value : null));
}

let restoreLocation: (() => void) | null = null;

/**
 * jsdom treats `location.href = …` as a navigation it does not implement:
 * the assignment is logged and lost. Swap in a plain object so the page's
 * `window.location.href = returnPath` is observable.
 */
function stubLocation(): { href: string } {
  const realLocation = window.location;
  const stub = { href: 'http://localhost:3000/login' };
  Object.defineProperty(window, 'location', { configurable: true, value: stub });
  restoreLocation = () =>
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  return stub;
}

beforeEach(() => {
  mockSearchParamsGet.mockReturnValue(null);
  mockGetAuthProviders.mockImplementation(noProviders);
});

afterEach(() => {
  restoreLocation?.();
  restoreLocation = null;
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

/**
 * `?return=` is chosen by whoever wrote the link. `mockSearchParamsGet`
 * returns decoded values, so `'/\t/evil.example'` is what the page sees for
 * `?return=%2F%09%2Fevil.example`. A browser reads `\` as `/` and drops the TAB,
 * so both crafted values below would load `https://evil.example/`.
 */
describe('<LoginPage /> only follows same-origin return paths', () => {
  it.each(['/\\evil.example', '/\t/evil.example'])(
    'sends an authenticated visitor with ?return=%j to / instead of off-origin',
    async (crafted) => {
      givenReturn(crafted);
      mockGetSessionStatus.mockImplementation(authedSession);

      renderWithIntl(<LoginPage />);

      await waitFor(() => expect(mockReplace).toHaveBeenCalled());
      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(mockReplace).not.toHaveBeenCalledWith(crafted);
    },
  );

  it.each(['/login?x=1', '/login/', '/setup'])(
    'extends the loop guard to ?return=%j',
    async (authPage) => {
      givenReturn(authPage);
      mockGetSessionStatus.mockImplementation(authedSession);

      renderWithIntl(<LoginPage />);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    },
  );

  it('forwards the normalised value, not the raw one, on the hop to /setup', async () => {
    givenReturn('/\\evil.example');
    mockGetSessionStatus.mockImplementation(unauthedSession);
    mockGetAuthProviders.mockImplementation(setupRequired);

    renderWithIntl(<LoginPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/setup?return=%2F'));
  });

  it('points the OIDC button at the sanitised path', async () => {
    givenReturn('/\\evil.example');
    mockGetSessionStatus.mockImplementation(unauthedSession);
    mockGetAuthProviders.mockImplementation(oidcProvider);

    renderWithIntl(<LoginPage />);

    const link = await screen.findByRole('link', { name: 'Continue with Microsoft' });
    expect(link).toHaveAttribute('href', '/bot-api/v1/auth/login/entra/start?return=%2F');
  });

  it.each([
    ['/\\evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['/chat?thread=42', '/chat?thread=42'],
  ])(
    'after a successful password login with ?return=%j navigates to %j',
    async (returnValue, expected) => {
      givenReturn(returnValue);
      mockGetSessionStatus.mockImplementation(unauthedSession);
      mockGetAuthProviders.mockImplementation(passwordProvider);
      mockPostAuthLogin.mockResolvedValue({ ok: true });

      renderWithIntl(<LoginPage />);

      fireEvent.change(await screen.findByLabelText('Email'), {
        target: { value: 'admin@example.com' },
      });
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'synthetic-password' },
      });
      const location = stubLocation();
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(location.href).toBe(expected));
      expect(mockPostAuthLogin).toHaveBeenCalledWith('local', {
        email: 'admin@example.com',
        password: 'synthetic-password',
      });
    },
  );
});

describe('<LoginPage /> sign-in errors', () => {
  function emailPasswordProvider() {
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
    mockGetAuthProviders.mockImplementation(emailPasswordProvider);
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
