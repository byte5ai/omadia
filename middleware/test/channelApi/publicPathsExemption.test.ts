import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publicPaths } from '../../src/auth/publicPaths.js';

/**
 * Issue #438 — the public chat ingress must bypass the session-cookie gate
 * (it authenticates itself via API key); the sibling key-lifecycle admin
 * routes under the SAME `/api/public/v1` prefix must NOT — they stay behind
 * the operator's normal session, like every other admin surface. Asserted
 * against the SAME shared array production uses (see the doc comment at the
 * top of `publicPaths.ts` for why this file exists as a constant).
 */
describe('publicPaths — @omadia/channel-api exemption', () => {
  const paths = publicPaths({ devEndpointsEnabled: false });
  const isPublic = (path: string): boolean => paths.some((re) => re.test(path));

  it('exempts the public chat route', () => {
    assert.equal(isPublic('/api/public/v1/chat'), true);
  });

  it('does NOT exempt the key-admin routes — they stay session-gated', () => {
    assert.equal(isPublic('/api/public/v1/admin/keys'), false);
    assert.equal(isPublic('/api/public/v1/admin/keys/abc/revoke'), false);
  });

  it('does not exempt an unrelated path that merely starts with the prefix', () => {
    assert.equal(isPublic('/api/public/v1/chatty-unrelated'), false);
  });
});
