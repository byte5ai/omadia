import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import SetupPage from '../page';

/**
 * /setup creates the first administrator, then sends the browser to
 * `?return=`. That value comes from the URL, so the page sanitises it to a
 * same-origin path first (`_lib/returnPath.ts`). These tests pin where the
 * browser goes after a successful setup. `mockSearchParamsGet` returns
 * decoded values: `'/\t/evil.com'` is what the page sees for
 * `?return=%2F%09%2Fevil.com`.
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

vi.mock('../../_lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  getAuthProviders: mockGetAuthProviders,
  postAuthSetup: mockPostAuthSetup,
}));

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

async function fillAndSubmit(): Promise<{ href: string }> {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText('Password (min 8 chars)'), {
    target: { value: PASSWORD },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: PASSWORD },
  });
  const location = stubLocation();
  fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
  return location;
}

beforeEach(() => {
  mockSearchParamsGet.mockReturnValue(null);
  mockGetAuthProviders.mockResolvedValue({ providers: [], setup_required: true });
  mockPostAuthSetup.mockResolvedValue({ ok: true });
});

afterEach(() => {
  restoreLocation?.();
  restoreLocation = null;
  vi.clearAllMocks();
});

describe('<SetupPage /> return path after the first admin is created', () => {
  it.each([
    ['/\\evil.com', '/'],
    ['/\t/evil.com', '/'],
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
