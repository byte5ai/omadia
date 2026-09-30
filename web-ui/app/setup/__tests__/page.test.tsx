import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import SetupPage from '../page';

/**
 * The first-user wizard and the operator setup token.
 *
 * A server install demands the token the middleware prints at boot (or
 * ADMIN_SETUP_TOKEN); the desktop app's kernel does not. The page learns which
 * from `/providers.setup_token_required`, shows the field only then, sends it
 * as `setup_token`, and turns each refusal code into its own message instead
 * of a raw error string.
 */

const { mockReplace, mockGetAuthProviders, mockPostAuthSetup } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockGetAuthProviders: vi.fn(),
  mockPostAuthSetup: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: () => null }),
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

async function fillAndSubmit(opts: { token?: string } = {}): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'admin@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password (min 8 chars)'), {
    target: { value: 'pw-with-12-chars' },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'pw-with-12-chars' },
  });
  if (opts.token !== undefined) {
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: opts.token } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
}

beforeEach(() => {
  mockPostAuthSetup.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<SetupPage /> — setup token', () => {
  it('asks for the token when the server requires one and sends it as setup_token', async () => {
    mockGetAuthProviders.mockImplementation(() => providers(true));
    renderWithIntl(<SetupPage />);

    expect(await screen.findByLabelText('Setup token')).toBeInTheDocument();
    await fillAndSubmit({ token: '  generated-token-0123456789abcdef  ' });

    await waitFor(() => expect(mockPostAuthSetup).toHaveBeenCalledTimes(1));
    expect(mockPostAuthSetup).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'pw-with-12-chars',
      setup_token: 'generated-token-0123456789abcdef',
    });
  });

  it('shows no token field and sends no token when none is required (desktop app)', async () => {
    mockGetAuthProviders.mockImplementation(() => providers(false));
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
    expect(mockReplace).not.toHaveBeenCalled();
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
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('410 auth.setup_locked: someone else finished setup → login', async () => {
    mockPostAuthSetup.mockRejectedValue(refusal(410, 'auth.setup_locked'));
    renderWithIntl(<SetupPage />);
    await fillAndSubmit({ token: 'generated-token-0123456789abcdef' });

    expect(
      await screen.findByText('Setup is already locked — another user has been created.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'), { timeout: 3_000 });
  });
});
