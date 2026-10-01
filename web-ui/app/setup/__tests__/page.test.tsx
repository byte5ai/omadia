import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import SetupPage from '../page';

/**
 * The first-user wizard: where the browser goes afterwards, and the operator
 * setup token.
 *
 * /setup creates the first administrator, then sends the browser to
 * `?return=`. That value comes from the URL, so the page sanitises it to a
 * same-origin path first (`_lib/returnPath.ts`). `mockSearchParamsGet` returns
 * decoded values: `'/\t/evil.example'` is what the page sees for
 * `?return=%2F%09%2Fevil.example`.
 *
 * A server install demands the token the middleware prints at boot (or
 * ADMIN_SETUP_TOKEN); the desktop app's kernel does not. The page learns which
 * from `/providers.setup_token_required`, shows the field only then, sends it
 * as `setup_token`, and turns each refusal code into its own message instead
 * of a raw error string.
 */

const { mockRouter, mockSearchParamsGet, mockGetAuthProviders, mockPostAuthSetup } =
  vi.hoisted(() => ({
    // Stable across renders, like Next's own router.
    mockRouter: { replace: vi.fn() },
    mockSearchParamsGet: vi.fn<(key: string) => string | null>(() => null),
    mockGetAuthProviders: vi.fn(),
    mockPostAuthSetup: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// Keep the real ApiError (its `code` comes from the JSON body); stub the calls.
vi.mock('../../_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/api')>();
  return {
    ...actual,
    getAuthProviders: mockGetAuthProviders,
    postAuthSetup: mockPostAuthSetup,
  };
});

function providers(tokenRequired: boolean) {
  return Promise.resolve({
    providers: [],
    setup_required: true,
    setup_token_required: tokenRequired,
  });
}

function refusal(status: number, code: string): ApiError {
  return new ApiError(status, `HTTP ${String(status)}`, JSON.stringify({ code, message: 'raw server text' }));
}

let restoreLocation: (() => void) | null = null;

/**
 * jsdom treats `location.href = …` as a navigation it does not implement:
 * the assignment is logged and lost. Swap in a plain object so the page's
 * `window.location.href = returnPath` is observable.
 */
function stubLocation(): { href: string } {
  const realLocation = window.location;
  const stub = { href: 'http://localhost:3000/setup' };
  Object.defineProperty(window, 'location', { configurable: true, value: stub });
  restoreLocation = () =>
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  return stub;
}

const EMAIL = 'admin@example.com';
const PASSWORD = 'synthetic-pass-1';

async function fillAndSubmit(opts: { token?: string } = {}): Promise<{ href: string }> {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText('Password (min 8 chars)'), {
    target: { value: PASSWORD },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: PASSWORD },
  });
  if (opts.token !== undefined) {
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: opts.token } });
  }
  const location = stubLocation();
  fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
  return location;
}

beforeEach(() => {
  mockSearchParamsGet.mockReturnValue(null);
  mockGetAuthProviders.mockImplementation(() => providers(false));
  mockPostAuthSetup.mockResolvedValue({ ok: true });
});

afterEach(() => {
  restoreLocation?.();
  restoreLocation = null;
  vi.clearAllMocks();
});

describe('<SetupPage /> return path after the first admin is created', () => {
  it.each([
    ['/\\evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['/login?x=1', '/'],
    ['/admin/providers', '/admin/providers'],
    ['/chat?thread=42#c', '/chat?thread=42#c'],
  ])('with ?return=%j navigates to %j', async (returnValue, expected) => {
    mockSearchParamsGet.mockImplementation((key) => (key === 'return' ? returnValue : null));

    renderWithIntl(<SetupPage />);
    const location = await fillAndSubmit();

    await waitFor(() => expect(location.href).toBe(expected));
    expect(mockPostAuthSetup).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });

  it("defaults to '/' when no ?return is given", async () => {
    renderWithIntl(<SetupPage />);
    const location = await fillAndSubmit();

    await waitFor(() => expect(location.href).toBe('/'));
  });
});

describe('<SetupPage /> — setup token', () => {
  it('asks for the token when the server requires one and sends it as setup_token', async () => {
    mockGetAuthProviders.mockImplementation(() => providers(true));
    renderWithIntl(<SetupPage />);

    expect(await screen.findByLabelText('Setup token')).toBeInTheDocument();
    await fillAndSubmit({ token: '  generated-token-0123456789abcdef  ' });

    await waitFor(() => expect(mockPostAuthSetup).toHaveBeenCalledTimes(1));
    expect(mockPostAuthSetup).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
      setup_token: 'generated-token-0123456789abcdef',
    });
  });

  it('shows no token field and sends no token when none is required (desktop app)', async () => {
    renderWithIntl(<SetupPage />);

    await screen.findByLabelText('Email');
    expect(screen.queryByLabelText('Setup token')).toBeNull();
    await fillAndSubmit();

    await waitFor(() => expect(mockPostAuthSetup).toHaveBeenCalledTimes(1));
    const body = mockPostAuthSetup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('setup_token');
  });
});

describe('<SetupPage /> — refusals get their own message', () => {
  beforeEach(() => {
    mockGetAuthProviders.mockImplementation(() => providers(true));
  });

  it('403: a wrong token says so instead of echoing the raw error', async () => {
    mockPostAuthSetup.mockRejectedValue(refusal(403, 'auth.setup_token_invalid'));
    renderWithIntl(<SetupPage />);
    await fillAndSubmit({ token: 'wrong-token-0123456789' });

    expect(
      await screen.findByText(
        'The setup token is missing or wrong. Copy it from the middleware log and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text|HTTP 403/)).toBeNull();
  });

  it('409: a concurrent setup asks to retry', async () => {
    mockPostAuthSetup.mockRejectedValue(refusal(409, 'auth.setup_in_progress'));
    renderWithIntl(<SetupPage />);
    await fillAndSubmit({ token: 'generated-token-0123456789abcdef' });

    expect(
      await screen.findByText('Another setup request is being processed. Wait a moment and try again.'),
    ).toBeInTheDocument();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('410 auth.setup_disabled: names the restart and does not bounce to /login', async () => {
    mockPostAuthSetup.mockRejectedValue(refusal(410, 'auth.setup_disabled'));
    renderWithIntl(<SetupPage />);
    await fillAndSubmit({ token: 'generated-token-0123456789abcdef' });

    expect(
      await screen.findByText(
        'Setup is not available on this server start. Restart the middleware, then reload this page.',
      ),
    ).toBeInTheDocument();
    // The locked path redirects after 1.5 s; the disabled one must not.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('410 auth.setup_locked: someone else finished setup → login', async () => {
    mockPostAuthSetup.mockRejectedValue(refusal(410, 'auth.setup_locked'));
    renderWithIntl(<SetupPage />);
    await fillAndSubmit({ token: 'generated-token-0123456789abcdef' });

    expect(
      await screen.findByText('Setup is already locked — another user has been created.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/login'), { timeout: 3_000 });
  });
});
