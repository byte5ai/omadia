import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionStatus } from '../api';

/**
 * #1322 — a 401 from /auth/me tells a server-side revocation (`auth.revoked`:
 * signed out on another device, ended by an admin) apart from a plain
 * expiry, so the SessionWatcher can say "ended" instead of "expired".
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function unauthorized(body: string): Response {
  return new Response(body, { status: 401 });
}

describe('getSessionStatus — 401 reason (#1322)', () => {
  it('reports revoked for auth.revoked', async () => {
    fetchMock.mockResolvedValue(unauthorized(JSON.stringify({ code: 'auth.revoked' })));
    const status = await getSessionStatus();
    expect(status.authenticated).toBe(false);
    expect(status.reason).toBe('revoked');
  });

  it.each(['auth.missing', 'auth.invalid'])('reports expired for %s', async (code) => {
    fetchMock.mockResolvedValue(unauthorized(JSON.stringify({ code })));
    const status = await getSessionStatus();
    expect(status.authenticated).toBe(false);
    expect(status.reason).toBe('expired');
  });

  it('falls back to expired for a non-JSON body', async () => {
    fetchMock.mockResolvedValue(unauthorized('<html>Unauthorized</html>'));
    expect((await getSessionStatus()).reason).toBe('expired');
  });

  it('carries no reason while authenticated', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'u1', email: 'a@example.com', display_name: 'A' },
          expires_at: 2000,
          server_now: 1000,
          renewable_until: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const status = await getSessionStatus();
    expect(status.authenticated).toBe(true);
    expect(status.reason).toBeUndefined();
  });
});
