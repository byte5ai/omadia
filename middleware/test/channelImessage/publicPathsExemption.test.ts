import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publicPaths } from '../../src/auth/publicPaths.js';

/**
 * Issue #410 — the iMessage channel's public routes must bypass the `/api`
 * `requireAuth` session gate (Sendblue POSTs the webhook with no cookie; the
 * answer links open in a plain browser where no operator session exists), and
 * the plugin's admin UI under `/api/imessage-channel/` must NOT. Asserted
 * against the SAME shared array production uses — see the doc comment at the
 * top of `publicPaths.ts` for why that constant exists.
 *
 * WHY THIS FILE EXISTS NEXT TO staticPublicPathsClosedSet.test.ts
 * ---------------------------------------------------------------
 * The closed-set suite holds one owner row per entry and the iMessage entry
 * admits THREE route families (`webhook|a|answers`). One row can name one
 * path, so that suite stays green if the regex is narrowed to `webhook` only —
 * while every answer link 401s in production. This file pins each family, so
 * that narrowing goes red at the commit that makes it.
 *
 * WHY IT ALSO PINS THE PREFIX
 * ---------------------------
 * `/api/imessage` is the plugin's `ROUTE_PREFIX` (`omadia-channel-imessage/
 * src/plugin.ts`), out of tree — there is no shared constant to build the
 * exemption from, unlike the Teams entry. The plugin's integration test pins
 * the prefix it registers; this file pins the prefix core exempts. Both sides
 * naming the same literal is the contract; a rename lands in both repos or
 * goes red in one of them.
 *
 * NOTE: as with `channelApi/publicPathsExemption.test.ts`, not being exempted
 * here is necessary but NOT sufficient for the admin routes — the plugin mounts
 * them via `ctx.routes.register`, and their real gate is checked inside the
 * plugin's admin router. This file proves only the publicPaths half.
 */
describe('publicPaths — @omadia/channel-imessage exemption (#410)', () => {
  const paths = publicPaths();
  const isPublic = (path: string): boolean => paths.some((re) => re.test(path));

  /** Every public surface the plugin mounts under its prefix. */
  const PUBLIC: readonly string[] = [
    // Sendblue receive-webhook; the shared secret rides in the path segment.
    '/api/imessage/webhook/tok',
    // Answer-link page, and the static og:image Apple's preview crawler fetches.
    '/api/imessage/a/tok',
    '/api/imessage/a/assets/preview.jpg',
    // Structured payload + the one mutating route, the reply.
    '/api/imessage/answers/tok',
    '/api/imessage/answers/tok/reply',
  ];

  for (const path of PUBLIC) {
    it(`exempts ${path}`, () => {
      assert.equal(
        isPublic(path),
        true,
        `${path} must skip the session gate — the plugin authenticates it itself ` +
          '(shared secret or single-use capability token). A 401 here is the ' +
          'blanket /api guard answering before the plugin router is reached.',
      );
    });
  }

  it('does NOT exempt the admin UI — it stays session-gated', () => {
    assert.equal(isPublic('/api/imessage-channel/admin/x'), false);
    assert.equal(isPublic('/api/imessage-channel/admin/index.html'), false);
  });

  /**
   * Near misses. The entry names three families, not the `/api/imessage`
   * prefix — a prefix entry would hand every present and future sibling the
   * same free pass.
   */
  const GATED: readonly string[] = [
    '/api/imessage',
    '/api/imessage/',
    '/api/imessage/answers2',
    '/api/imessage/admin',
    '/api/imessage/webhooks',
    '/api/imessages/webhook/tok',
  ];

  for (const path of GATED) {
    it(`still gates ${path}`, () => {
      assert.equal(
        isPublic(path),
        false,
        `${path} is not one of the three public route families, so nothing about ` +
          'it self-authenticates. Widening the entry to the prefix would open it.',
      );
    });
  }
});
