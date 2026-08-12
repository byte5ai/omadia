import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publicPaths } from '../../src/auth/publicPaths.js';

/**
 * Issue #438 — the public chat ingress must bypass the `requireAuth` session
 * gate (it authenticates itself via API key); the sibling key-lifecycle
 * admin routes under the SAME `/api/public/v1` prefix must NOT be exempted
 * here. Asserted against the SAME shared array production uses (see the doc
 * comment at the top of `publicPaths.ts` for why this file exists as a
 * constant).
 *
 * NOTE: not being exempted here is necessary but NOT sufficient for the
 * admin routes' security — `core.registerRouter` (how this plugin actually
 * mounts, in `plugin.ts`) never runs `requireAuth` at all, exempted or not
 * (see `RoutesAccessor`'s doc comment on `PluginContext`: the kernel injects
 * no auth middleware around a plugin-contributed router). The REAL gate for
 * `/admin/keys` is `ctx.operatorAuth`, checked explicitly inside
 * `adminKeysRouter.ts` itself — see that file's doc comment and
 * `adminKeysRouter.test.ts`'s "operator-session auth" block for that
 * coverage. This file only proves the (necessary, not sufficient) publicPaths
 * half of the story.
 */
describe('publicPaths — @omadia/channel-api exemption', () => {
  const paths = publicPaths();
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
