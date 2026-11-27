import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { fileLinkFailure, isSignedLinkExpired, signedLinkExpiry } from './fileLinkRenewal';

const NOW_MS = 2_000_000_000 * 1000;

describe('#1964 · signed file links in the chat', () => {
  it('reads exp from absolute and relative links', () => {
    expect(signedLinkExpiry('https://x.example/diagrams/dl/a.png?exp=123&sig=ab')).toBe(123);
    expect(signedLinkExpiry('/documents/dl/a.xlsx?exp=456&sig=ab')).toBe(456);
    expect(signedLinkExpiry('https://x.example/a.png')).toBeUndefined();
    expect(signedLinkExpiry('https://x.example/a.png?exp=soon')).toBeUndefined();
  });

  it('treats a link as expired shortly before its exp, never without one', () => {
    expect(isSignedLinkExpired('/d?exp=1999999999&sig=a', NOW_MS)).toBe(true);
    expect(isSignedLinkExpired('/d?exp=2000000010&sig=a', NOW_MS)).toBe(true);
    expect(isSignedLinkExpired('/d?exp=2000003600&sig=a', NOW_MS)).toBe(false);
    expect(isSignedLinkExpired('/d', NOW_MS)).toBe(false);
  });

  it('maps renew refusals to the chat message', () => {
    expect(fileLinkFailure(new ApiError(410, 'x', '{"code":"file_link.too_old"}'))).toBe('tooOld');
    expect(fileLinkFailure(new ApiError(404, 'x', '{"code":"file_link.unknown_route"}'))).toBe('unavailable');
    expect(fileLinkFailure(new ApiError(403, 'x', '{"code":"file_link.invalid_signature"}'))).toBe('failed');
    expect(fileLinkFailure(new Error('network'))).toBe('failed');
  });
});
