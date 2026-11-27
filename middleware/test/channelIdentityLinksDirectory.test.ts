/**
 * ADR-0300 — an operator links a Telegram account to a directory person (a
 * colleague of the Entra tenant without a web login): the picker lists active
 * people as `directory:<id>`, the redeem joins the person's Teams cluster and
 * records `linkedDirectoryPersonId`, a deprovisioned person names nobody.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createChannelIdentityLinks } from '../src/channels/channelIdentityLinks.js';
import type { DirectoryPerson } from '../src/directory/directoryStore.js';

const OPERATOR = { userId: '7d1c2b3a-0000-4000-8000-00000000b002', email: 'op@example.com' };
const COOKIE = 'omadia_session=valid';
const SENDER = 'telegram:4711';
const OID = '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const ENTRA_OID = '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

function person(id: string, externalId: string, status: DirectoryPerson['status'] = 'active'): DirectoryPerson {
  return {
    id,
    source: 'entra',
    tenantId: '11111111-2222-4333-8444-555555555555',
    externalId,
    upn: `${id}@contoso.com`,
    mail: null,
    displayName: id === 'p1' ? 'Paula' : 'Eve',
    accountEnabled: status === 'active',
    status,
    firstSeenAt: new Date(0),
    syncedAt: new Date(0),
    deprovisionedAt: null,
  };
}

function setup() {
  const kg = new InMemoryKnowledgeGraph();
  const people = new Map<string, DirectoryPerson>([
    ['p1', person('p1', OID)],
    ['p2', person('p2', ENTRA_OID)],
  ]);
  const audit: AuditEntryInput[] = [];
  const links = createChannelIdentityLinks({
    operatorOf: async (cookie) => (cookie === COOKIE ? OPERATOR : null),
    users: () => ({
      findById: async () => null,
      // p2 has an Entra web login: offered as the account only.
      list: async () => [
        {
          id: 'u-entra',
          email: 'eve@contoso.com',
          provider: 'entra',
          providerUserId: ENTRA_OID,
          displayName: 'Eve',
          role: 'admin',
          status: 'active',
          createdAt: new Date(0),
          updatedAt: new Date(0),
          lastLoginAt: null,
          sessionVersion: 0,
        },
      ],
    }),
    knowledgeGraph: () => kg,
    audit: () => ({ record: async (e) => void audit.push(e) }),
    directory: () => ({
      findById: async (id) => people.get(id) ?? null,
      list: async () => ({ people: [...people.values()].filter((p) => p.status === 'active'), total: people.size }),
    }),
    log: () => undefined,
  });
  return { kg, links, audit, people };
}

describe('ADR-0300 · linking a channel account to a directory person', () => {
  it('lists active people without a web login as directory:<id>', async () => {
    const { links } = setup();
    const listed = await links.listLinkableAccounts(COOKIE);
    assert.deepEqual(
      listed?.map((a) => [a.userId, a.kind]),
      [
        ['u-entra', 'account'],
        ['directory:p1', 'person'],
      ],
    );
  });

  it('offers, redeems into the person cluster, audits and reports the link', async () => {
    const { kg, links, audit } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: 'directory:p1' });
    assert.ok(offer.ok);
    const redeemed = await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.ok(redeemed.ok);
    assert.equal(redeemed.link.userId, 'directory:p1');
    const teams = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: OID, aadObjectId: OID });
    const telegram = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: SENDER });
    assert.equal(telegram.omadiaUserId, teams.omadiaUserId);
    assert.equal(telegram.linkedDirectoryPersonId, 'p1');
    assert.deepEqual(audit[0]?.after, { linkedDirectoryPersonId: 'p1' });
    assert.equal((await links.linkOf({ channelType: 'telegram', channelUserId: SENDER }))?.userId, 'directory:p1');
  });

  it('a deprovisioned person can be neither offered nor reported', async () => {
    const { links, people } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: 'directory:p1' });
    assert.ok(offer.ok);
    await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    people.set('p1', person('p1', OID, 'deprovisioned'));
    assert.equal(await links.linkOf({ channelType: 'telegram', channelUserId: SENDER }), null);
    const again = await links.offerLink(COOKIE, { channelType: 'telegram', userId: 'directory:p1' });
    assert.deepEqual(again, { ok: false, reason: 'unknown_user' });
  });

  it('an operator unlinks a person link like an account link', async () => {
    const { links, audit } = setup();
    const offer = await links.offerLink(COOKIE, { channelType: 'telegram', userId: 'directory:p1' });
    assert.ok(offer.ok);
    await links.redeemLink({ channelType: 'telegram', channelUserId: SENDER, offerId: offer.offerId });
    assert.deepEqual(await links.unlink(COOKIE, { channelType: 'telegram', channelUserId: SENDER }), { ok: true });
    assert.deepEqual(audit.at(-1)?.before, { linkedDirectoryPersonId: 'p1' });
  });
});
