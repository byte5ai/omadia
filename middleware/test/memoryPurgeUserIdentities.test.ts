/**
 * #2292 / #2293 — a user purge reaches everything that hangs off the person's
 * `User` cluster in ONE run:
 *
 *   - the per-channel context trees of every linked channel identity
 *     (`/memories/contexts/<agent>/user/<kind>~<id>`), not only the identity
 *     the selector named (#2293);
 *   - the open web sessions of the person's accounts (`web:<users.id>`
 *     identities), so nobody keeps writing under the deleted omadia user id
 *     until the next sign-in (#2292).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { memoryContextKey } from '@omadia/channel-sdk';

import { codes, makeHarness, preview, previewAndPurge } from './_helpers/memoryPurgeHarness.js';

const ACCOUNT = '3c7d1e00-0000-4000-8000-0000000acc01';
const TELEGRAM_ID = '4242';
const SLACK_ID = 'U-carla';
const EMAIL = 'carla@example.com';

async function linkCarla(h: Awaited<ReturnType<typeof makeHarness>>): Promise<string> {
  // A verified e-mail joins the identities into one cluster.
  const { omadiaUserId } = await h.kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ACCOUNT,
    email: EMAIL,
    emailVerified: true,
  });
  for (const [channelKind, channelUserId] of [
    ['telegram', TELEGRAM_ID],
    ['slack', SLACK_ID],
  ] as const) {
    const linked = await h.kg.resolveOrCreateChannelIdentity({
      channelKind,
      channelUserId,
      email: EMAIL,
      emailVerified: true,
    });
    assert.equal(linked.omadiaUserId, omadiaUserId, `${channelKind} joined the cluster`);
  }
  await h.store.createFile(
    `/memories/contexts/a/user/${memoryContextKey('telegram', TELEGRAM_ID)}/n.md`,
    'telegram dm note',
  );
  await h.store.createFile(
    `/memories/contexts/b/user/${memoryContextKey('slack', SLACK_ID)}/n.md`,
    'slack dm note',
  );
  return omadiaUserId;
}

describe('#2293 — a user purge covers every linked channel identity', () => {
  for (const [label, selectorOf] of [
    ['omadia user id', (id: string) => id],
    ['account id', () => ACCOUNT],
    ['one channel identity', () => `telegram~${TELEGRAM_ID}`],
  ] as const) {
    it(`by ${label}: removes the context trees of all identities`, async () => {
      const h = await makeHarness();
      try {
        const omadiaUserId = await linkCarla(h);
        const r = await previewAndPurge(h, { axis: 'user', selector: selectorOf(omadiaUserId) });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['scratchDeleted'], r.preview['scratchCount']);
        for (const path of [
          `/memories/contexts/a/user/${memoryContextKey('telegram', TELEGRAM_ID)}`,
          `/memories/contexts/b/user/${memoryContextKey('slack', SLACK_ID)}`,
        ]) {
          assert.equal(await h.store.directoryExists(path), false, `${path} survived`);
        }
        // Someone else's context tree stays.
        assert.equal(await h.store.directoryExists('/memories/contexts/a/user/teams~u-1'), true);
      } finally {
        await h.close();
      }
    });
  }
});

describe('#2292 — a user purge ends the person’s open web sessions', () => {
  it('revokes the sessions of the linked account and counts it', async () => {
    const revoked: string[][] = [];
    const h = await makeHarness({
      revokeAccountSessions: (ids) => {
        revoked.push([...ids]);
        return Promise.resolve(ids.length);
      },
    });
    try {
      const omadiaUserId = await linkCarla(h);
      const r = await previewAndPurge(h, { axis: 'user', selector: omadiaUserId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.preview['sessionAccountCount'], 1);
      assert.equal(r.body['sessionsRevoked'], 1);
      assert.deepEqual(revoked, [[ACCOUNT]]);
    } finally {
      await h.close();
    }
  });

  it('warns when sessions cannot be revoked on this boot', async () => {
    const h = await makeHarness();
    try {
      const omadiaUserId = await linkCarla(h);
      const p = await preview(h, { axis: 'user', selector: omadiaUserId });
      assert.ok(codes(p.body).includes('sessions_not_revoked'), JSON.stringify(p.body));
    } finally {
      await h.close();
    }
  });

  it('revokes nothing for a person without an account', async () => {
    let called = false;
    const h = await makeHarness({
      revokeAccountSessions: () => {
        called = true;
        return Promise.resolve(0);
      },
    });
    try {
      const { omadiaUserId } = await h.kg.resolveOrCreateChannelIdentity({
        channelKind: 'telegram',
        channelUserId: '99',
      });
      const r = await previewAndPurge(h, { axis: 'user', selector: omadiaUserId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body['sessionsRevoked'], 0);
      assert.equal(called, false);
    } finally {
      await h.close();
    }
  });
});
