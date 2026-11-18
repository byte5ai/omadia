import { describe, expect, it } from 'vitest';

import en from '../../../../../messages/en.json';
import { ApiError } from '../../../../_lib/api';
import { toFriendlyError } from '../shared';

/** Resolves `errors.*` against the real English catalogue, ICU-lite. */
const t = (key: string, values?: Record<string, string | number>): string => {
  const [, leaf] = key.split('.');
  const text = (en.adminWebhooks.errors as Record<string, string>)[leaf ?? ''] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
};

const BODY =
  '{"code":"conductor.webhook_url_forbidden","message":"\'169.254.169.254\' is a private, loopback, link-local or otherwise non-public address"}';

describe('webhook toFriendlyError (#1338)', () => {
  it('maps a forbidden URL to localized copy, bound to the URL field', () => {
    const friendly = toFriendlyError(new ApiError(400, 'POST failed: 400', BODY), t);
    expect(friendly.message).toBe(en.adminWebhooks.errors.urlForbidden);
    expect(friendly.field).toBe('url');
    expect(friendly.detail).toContain('169.254.169.254');
  });

  it('never shows the raw JSON body', () => {
    const friendly = toFriendlyError(new ApiError(400, 'POST failed: 400', BODY), t);
    expect(friendly.message).not.toContain('{');
    expect(friendly.detail ?? '').not.toContain('"code"');
  });

  it('gives every conductor *_failed code one server-failure line', () => {
    const err = new ApiError(
      500,
      'POST failed: 500',
      '{"code":"conductor.webhook_rotate_failed","message":"db down"}',
    );
    expect(toFriendlyError(err, t)).toEqual({
      message: en.adminWebhooks.errors.serverFailed,
      detail: 'db down',
    });
  });

  it('falls back to a localized status line for an unknown code or body', () => {
    const friendly = toFriendlyError(new ApiError(502, 'GET failed: 502', 'Bad Gateway'), t);
    expect(friendly.message).toBe('The request failed (HTTP 502).');
    expect(friendly.detail).toBeUndefined();
  });

  it('keeps a network error as detail under a localized headline', () => {
    expect(toFriendlyError(new TypeError('Failed to fetch'), t)).toEqual({
      message: en.adminWebhooks.errors.unexpected,
      detail: 'Failed to fetch',
    });
  });
});
