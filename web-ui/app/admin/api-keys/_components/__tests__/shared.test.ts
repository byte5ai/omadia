import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { toFriendlyError } from '../shared';

/**
 * Session refusals from the kernel's `requireAuth` map to the session
 * messages — a server-side revocation (`auth.revoked`) reads like an expired
 * session, and a failed session check (`auth.unavailable`, 503) like the
 * transient outage it is, never the generic "error (status N)".
 */
const t = (key: string): string => key;

function refusal(status: number, code: string): ApiError {
  return new ApiError(status, `request failed: ${String(status)}`, JSON.stringify({ code }));
}

describe('toFriendlyError — session refusals', () => {
  it('maps every dead-session code to sessionExpired', () => {
    for (const code of ['auth.missing', 'auth.invalid', 'auth.revoked']) {
      expect(toFriendlyError(refusal(401, code), t)).toBe('errors.sessionExpired');
    }
  });

  it('maps a failed session check to authUnavailable, like the plugin outage', () => {
    expect(toFriendlyError(refusal(503, 'auth.unavailable'), t)).toBe('errors.authUnavailable');
    expect(toFriendlyError(refusal(503, 'operator_auth.unavailable'), t)).toBe(
      'errors.authUnavailable',
    );
  });
});
