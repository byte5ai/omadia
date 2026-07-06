import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import LoginPage from '../page';

/**
 * Coverage for the /login redirect path: an already-authenticated visitor
 * is bounced to the sanitised returnPath, and the ?return=/login loop is
 * short-circuited to '/'.
 */

const { mockReplace, mockSearchParamsGet, mockGetSessionStatus, mockGetAuthProviders } =
  vi.hoisted(() => ({
    mockReplace: vi.fn(),
    mockSearchParamsGet: vi.fn<(key: string) => string | null>(() => null),
    mockGetSessionStatus: vi.fn(),
    mockGetAuthProviders: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

vi.mock('../../_lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  getSessionStatus: mockGetSessionStatus,
  getAuthProviders: mockGetAuthProviders,
  postAuthLogin: vi.fn(),
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
  return Promise.resolve({ providers: [], setup_required: false });
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
