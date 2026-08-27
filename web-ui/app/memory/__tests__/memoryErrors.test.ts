import { describe, expect, it } from 'vitest';

import {
  isRouterNotFoundBody,
  looksLikeErrorPage,
  memoryErrorKey,
} from '../_lib/memoryErrors';

/**
 * #860 / W2a — what the memory browser SAYS about a non-200.
 *
 * The load-bearing case is the 404. Once the browser reads the operator
 * endpoint instead of the dev one, an unmounted router and a deleted path both
 * arrive as 404 — and the two demand opposite reactions from an operator. They
 * are distinguishable: `operatorMemoryContexts.ts` skips its exists-check when
 * the resolved relative path is empty, so a MOUNTED router can never answer 404
 * for `/memories/contexts` itself.
 */
describe('memoryErrorKey', () => {
  it('gives the auth answers their own copy', () => {
    expect(memoryErrorKey(401, false)).toBe('errorUnauthenticated');
    expect(memoryErrorKey(403, false)).toBe('errorForbidden');
  });

  it('reads a 404 on the contexts ROOT as an unreachable endpoint, not a missing path', () => {
    expect(memoryErrorKey(404, false, { atContextsRoot: true })).toBe(
      'errorEndpointUnreachable',
    );
  });

  it('reads a 404 that is not the router’s own JSON as an unreachable endpoint', () => {
    expect(memoryErrorKey(404, true, { isRouterNotFound: false })).toBe(
      'errorEndpointUnreachable',
    );
  });

  it('keeps "path is gone" for the router’s own 404 below the root', () => {
    expect(
      memoryErrorKey(404, false, {
        atContextsRoot: false,
        isRouterNotFound: true,
      }),
    ).toBe('errorPathNotFound');
  });

  it('says an error PAGE behind a 500 is server-side, and stays quiet otherwise', () => {
    expect(memoryErrorKey(500, true)).toBe('errorUpstreamErrorPage');
    expect(memoryErrorKey(500, false)).toBeNull();
    expect(memoryErrorKey(502, false)).toBeNull();
  });
});

describe('isRouterNotFoundBody', () => {
  it('recognises only the router’s own shape', () => {
    expect(isRouterNotFoundBody('{"error":"not_found"}')).toBe(true);
    expect(isRouterNotFoundBody('{"error":"invalid_path"}')).toBe(false);
    expect(isRouterNotFoundBody('<!doctype html><title>404</title>')).toBe(false);
    expect(isRouterNotFoundBody('')).toBe(false);
  });
});

describe('looksLikeErrorPage', () => {
  it('spots a proxy page by content type or by the doctype', () => {
    expect(looksLikeErrorPage('text/html; charset=utf-8', '')).toBe(true);
    expect(looksLikeErrorPage('', '  <!DOCTYPE html>')).toBe(true);
    expect(looksLikeErrorPage('application/json', '{"error":"not_found"}')).toBe(
      false,
    );
  });
});
