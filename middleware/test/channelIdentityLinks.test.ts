/**
 * ADR-0225 — the kernel's `CoreApi.channelIdentityLinks`: an operator offers,
 * the channel redeems with the attested sender, the kernel links and audits.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CoreApi } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { UserRecord } from '../src/auth/userStore.js';
import { createChannelIdentityLinks } from '../src/channels/channelIdentityLinks.js';
import { ChannelTypeClaims, scopeCoreApiToChannel } from '../src/channels/scopedCoreApi.js';

const OPERATOR = { userId: '7d1c2b3a-0000-4000-8000-00000000b002', email: 'op@example.com' };
const ANNA = '7d1c2b3a-0000-4000-8000-00000000a001';
const BEN = '7d1c2b3a-0000-4000-8000-00000000a002';
const COOKIE = 'omadia_session=valid';
const SENDER = 'telegram:4711';

function user(id: string, displayName: string, status: UserRecord['status'] = 'active'): UserRecord {
  return {
    id,
    email: `${displayName.toLowerCase()}@example.com`,
    provider: 'local',
    providerUserId: `${displayName.toLowerCase()}@example.com`,
    displayName,
    role: 'admin',
    status,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastLoginAt: null,
    sessionVersion: 0,
  };
}

function setup(opts: { audit?: boolean } = {}) {
  let clock = 1_000_000;
  const kg = new InMemoryKnowledgeGraph();
  const rows = [user(ANNA, 'Anna'), user(BEN, 'Ben', 'disabled')];
  const audit: AuditEntryInput[] = [];
  const links = createChannelIdentityLinks({
    operatorOf: async (cookie) => (cookie === COOKIE ? OPERATOR : null),
    users: () => ({
      findById: async (id) => rows.find((r) => r.id === id) ?? null,
      list: async () => rows,
    }),
    knowledgeGraph: () => kg,
    audit: () => (opts.audit === false ? undefined : { record: async (e) => void audit.push(e) }),
    now: () => clock,
    log: () => undefined,
  });
  return { kg, links, audit, advance: (ms: number) => (clock += ms) };
}

describe('ADR-0225 · kernel channel identity links', () => {
  it('lists only active accounts, and only to an operator session', async () => {
    const { links } = setup();
    assert.equal(await links.listLinkableAccounts(undefined), null);
    assert.equal(await links.listLinkableAccounts('omadia_session=forged'), null);
    assert.deepEqual(await links.listLinkableAccounts(COOKIE), [
      { userId: ANNA, displayName: 'Anna', email: 'anna@example.com' },
    ]);
  });

  it('offer → redeem links the sender to the account, audited under the offering operator', async () => {
    const { kg, links, audit } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(offer.ok);
    assert.equal(offer.account.displayName, 'Anna');
    const redeemed = await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.ok(redeemed.ok);
    assert.equal(redeemed.link.userId, ANNA);
    assert.equal(redeemed.link.displayName, 'Anna');

    const account = await kg.findOmadiaUserIdByChannelIdentity('web', ANNA);
    assert.equal(await kg.findOmadiaUserIdByChannelIdentity('telegram', SENDER), account);
    assert.deepEqual(await links.linkOf({ channelType: 'telegram', channelUserId: SENDER }), {
      channelType: 'telegram',
      channelUserId: SENDER,
      userId: ANNA,
      displayName: 'Anna',
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, 'channel_identity.link');
    assert.deepEqual(audit[0]!.actor, { id: OPERATOR.userId, email: OPERATOR.email });
    assert.equal(audit[0]!.target, `channel_identity:telegram:${SENDER}`);
  });

  it('refuses an offer without a session, for an unknown or disabled account, or a non-channel type', async () => {
    const { links } = setup();
    assert.deepEqual(await links.offerLink(undefined, { channelType: 'telegram', userId: ANNA }), {
      ok: false,
      reason: 'no_session',
    });
    for (const userId of ['nobody', BEN]) {
      assert.deepEqual(await links.offerLink(COOKIE, { channelType: 'telegram', userId }), {
        ok: false,
        reason: 'unknown_user',
      });
    }
    for (const channelType of ['web', 'api', 'carrier-pigeon']) {
      assert.deepEqual(await links.offerLink(COOKIE, { channelType, userId: ANNA }), {
        ok: false,
        reason: 'unsupported_channel',
      });
    }
  });

  it('an offer is single-use, bound to its channel type, and expires', async () => {
    const { links, advance } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA, ttlMs: 60_000 });
    assert.ok(offer.ok);
    const wrongType = await links.redeemLink({ channelType: 'slack', channelUserId: 'U1', offerId: offer.offerId });
    assert.deepEqual(wrongType, { ok: false, reason: 'unknown_offer' });
    // The failed attempt used the offer up.
    const again = await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.deepEqual(again, { ok: false, reason: 'unknown_offer' });

    const late = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA, ttlMs: 60_000 });
    assert.ok(late.ok);
    advance(60_001);
    assert.deepEqual(
      await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: late.offerId }),
      { ok: false, reason: 'unknown_offer' },
    );
  });

  it('links nothing it cannot record', async () => {
    const { links } = setup({ audit: false });
    assert.deepEqual(await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA }), {
      ok: false,
      reason: 'unavailable',
    });
  });

  it('unlink needs a session and a link, and gives the sender its own identity again', async () => {
    const { kg, links, audit } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(offer.ok);
    await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.deepEqual(await links.unlink(undefined, { channelType: 'telegram', channelUserId: SENDER }), {
      ok: false,
      reason: 'no_session',
    });
    assert.deepEqual(await links.unlink(COOKIE, { channelType: 'telegram', channelUserId: SENDER }), { ok: true });
    assert.equal(await links.linkOf({ channelType: 'telegram', channelUserId: SENDER }), null);
    assert.notEqual(
      await kg.findOmadiaUserIdByChannelIdentity('telegram', SENDER),
      await kg.findOmadiaUserIdByChannelIdentity('web', ANNA),
    );
    assert.equal(audit.at(-1)!.action, 'channel_identity.unlink');
    assert.deepEqual(await links.unlink(COOKIE, { channelType: 'telegram', channelUserId: SENDER }), {
      ok: false,
      reason: 'not_linked',
    });
  });

  it('a link to an account that was disabled later names nobody', async () => {
    const { kg, links } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(offer.ok);
    await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    // Simulate Anna being disabled: a fresh service over the same rows sees her status.
    const disabled = createChannelIdentityLinks({
      operatorOf: async () => OPERATOR,
      users: () => ({ findById: async () => user(ANNA, 'Anna', 'disabled'), list: async () => [] }),
      knowledgeGraph: () => kg,
      audit: () => undefined,
    });
    assert.equal((await links.linkOf({ channelType: 'telegram', channelUserId: SENDER }))?.userId, ANNA);
    assert.equal(await disabled.linkOf({ channelType: 'telegram', channelUserId: SENDER }), null);
  });

  it('links an Entra account that never signed in into its AAD cluster', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const teams = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: 'aad-9', aadObjectId: 'aad-9' });
    const entra = { ...user(ANNA, 'Anna'), provider: 'entra', providerUserId: 'aad-9' };
    const links = createChannelIdentityLinks({
      operatorOf: async () => OPERATOR,
      users: () => ({ findById: async () => entra, list: async () => [entra] }),
      knowledgeGraph: () => kg,
      audit: () => ({ record: async () => undefined }),
      log: () => undefined,
    });
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(offer.ok);
    await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.equal(await kg.findOmadiaUserIdByChannelIdentity('telegram', SENDER), teams.omadiaUserId);
  });

  it('refuses a missing channel user id instead of throwing', async () => {
    const { links } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(offer.ok);
    const bad = { channelType: 'telegram', offerId: offer.offerId } as unknown as Parameters<typeof links.redeemLink>[0];
    assert.deepEqual(await links.redeemLink(bad), { ok: false, reason: 'unknown_offer' });
    assert.equal(await links.linkOf({ channelType: 'telegram' } as never), null);
  });

  it('a plugin links accounts of its own channel type only', async () => {
    const { links } = setup();
    const claims = new ChannelTypeClaims();
    const core = { channelIdentityLinks: links } as unknown as CoreApi;
    const teams = scopeCoreApiToChannel(core, '@omadia/channel-teams', claims);
    const telegram = scopeCoreApiToChannel(core, '@omadia/channel-telegram', claims);
    // Telegram claims its type first.
    const own = await telegram.channelIdentityLinks!.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.ok(own.ok);
    const foreign = await teams.channelIdentityLinks!.offerLink(COOKIE, { channelType: 'telegram', userId: ANNA });
    assert.deepEqual(foreign, { ok: false, reason: 'unsupported_channel' });
    assert.deepEqual(
      await teams.channelIdentityLinks!.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: own.offerId }),
      { ok: false, reason: 'unsupported_channel' },
    );
    assert.equal(await teams.channelIdentityLinks!.linkOf({ channelType: 'telegram', channelUserId: SENDER }), null);
  });
});
