/**
 * ADR-0225 — the contract both graph backends implement for
 * `KnowledgeGraph.linkChannelIdentity`. One scenario list, run against the
 * in-memory graph (`channelIdentityLink.test.ts`) and Neon
 * (`channelIdentityLink.pg.test.ts`), so the two cannot drift.
 */
import { strict as assert } from 'node:assert';

import type { KnowledgeGraph } from '@omadia/plugin-api';

const ACCOUNT = '7d1c2b3a-0000-4000-8000-00000000a001';
const OPERATOR = '7d1c2b3a-0000-4000-8000-00000000b002';

async function accountCluster(kg: KnowledgeGraph): Promise<string> {
  const web = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ACCOUNT,
    displayName: 'Anna',
    email: 'anna@example.com',
    emailVerified: true,
    authSubject: { provider: 'local', providerUserId: 'anna@example.com' },
  });
  return web.omadiaUserId;
}

export async function linkJoinsAnExistingIdentityToTheAccount(kg: KnowledgeGraph): Promise<void> {
  const own = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4711' });
  const account = await accountCluster(kg);
  assert.notEqual(own.omadiaUserId, account);
  assert.equal(own.linkedUserId, undefined);

  const result = await kg.linkChannelIdentity!({
    channelKind: 'telegram',
    channelUserId: '4711',
    target: { omadiaUserId: account, userId: ACCOUNT, linkedBy: OPERATOR },
  });
  assert.equal(result.omadiaUserId, account);
  assert.equal(result.previousOmadiaUserId, own.omadiaUserId);

  const after = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4711' });
  assert.equal(after.omadiaUserId, account);
  assert.equal(after.linkedUserId, ACCOUNT);
  // The account's IdP subject now reaches the Telegram turn (per_user MCP tokens).
  assert.deepEqual(after.clusterAuthSubject, { provider: 'local', providerUserId: 'anna@example.com' });
  assert.equal(await kg.findOmadiaUserIdByChannelIdentity?.('telegram', '4711'), account);
}

export async function linkCreatesAMissingIdentity(kg: KnowledgeGraph): Promise<void> {
  const account = await accountCluster(kg);
  const result = await kg.linkChannelIdentity!({
    channelKind: 'telegram',
    channelUserId: '815',
    target: { omadiaUserId: account, userId: ACCOUNT },
    displayName: 'Anna T',
  });
  assert.equal(result.previousOmadiaUserId, undefined);
  const after = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '815' });
  assert.equal(after.omadiaUserId, account);
  assert.equal(after.linkedUserId, ACCOUNT);
  assert.equal(after.isNewIdentity, false);
}

export async function linkRefusesAnUnknownCluster(kg: KnowledgeGraph): Promise<void> {
  await assert.rejects(
    kg.linkChannelIdentity!({
      channelKind: 'telegram',
      channelUserId: '4712',
      target: { omadiaUserId: '00000000-0000-4000-8000-000000000000', userId: ACCOUNT },
    }),
    (err: unknown) => (err as { code?: string }).code === 'user_not_found',
  );
}

export async function unlinkGivesTheIdentityAClusterOfItsOwn(kg: KnowledgeGraph): Promise<void> {
  const account = await accountCluster(kg);
  await kg.linkChannelIdentity!({
    channelKind: 'telegram',
    channelUserId: '4713',
    target: { omadiaUserId: account, userId: ACCOUNT },
  });
  const result = await kg.linkChannelIdentity!({ channelKind: 'telegram', channelUserId: '4713', target: null });
  assert.notEqual(result.omadiaUserId, account);
  assert.equal(result.previousOmadiaUserId, account);
  const after = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4713' });
  assert.equal(after.omadiaUserId, result.omadiaUserId);
  assert.equal(after.linkedUserId, undefined);
  assert.equal(after.clusterAuthSubject, undefined);
  // The account keeps its own identity.
  assert.equal(await kg.findOmadiaUserIdByChannelIdentity?.('web', ACCOUNT), account);
}

export async function unlinkRefusesAnIdentityNobodyLinked(kg: KnowledgeGraph): Promise<void> {
  await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4714' });
  for (const channelUserId of ['4714', 'never-seen']) {
    await assert.rejects(
      kg.linkChannelIdentity!({ channelKind: 'telegram', channelUserId, target: null }),
      (err: unknown) => (err as { code?: string }).code === 'not_linked',
    );
  }
}

/** ADR-0300 — a link to a directory person joins their Teams cluster and records the person. */
export async function linkToADirectoryPersonRecordsThePerson(kg: KnowledgeGraph): Promise<void> {
  const oid = '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
  const teams = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: oid, aadObjectId: oid });
  await kg.linkChannelIdentity!({
    channelKind: 'telegram',
    channelUserId: '4720',
    target: { omadiaUserId: teams.omadiaUserId, directoryPersonId: 'person-1', linkedBy: OPERATOR },
  });
  const linked = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4720' });
  assert.equal(linked.omadiaUserId, teams.omadiaUserId);
  assert.equal(linked.linkedDirectoryPersonId, 'person-1');
  assert.equal(linked.linkedUserId, undefined);
  await kg.linkChannelIdentity!({ channelKind: 'telegram', channelUserId: '4720', target: null });
  const unlinked = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: '4720' });
  assert.notEqual(unlinked.omadiaUserId, teams.omadiaUserId);
  assert.equal(unlinked.linkedDirectoryPersonId, undefined);
  await assert.rejects(
    kg.linkChannelIdentity!({
      channelKind: 'telegram',
      channelUserId: '4721',
      target: { omadiaUserId: teams.omadiaUserId, userId: ACCOUNT, directoryPersonId: 'person-1' },
    }),
    (err: unknown) => (err as { code?: string }).code === 'invalid_link_target',
  );
}

export const LINK_CONTRACT: ReadonlyArray<readonly [string, (kg: KnowledgeGraph) => Promise<void>]> = [
  ['link joins an existing identity to the account cluster', linkJoinsAnExistingIdentityToTheAccount],
  ['link creates a missing identity in the account cluster', linkCreatesAMissingIdentity],
  ['link refuses a cluster that does not exist', linkRefusesAnUnknownCluster],
  ['unlink gives the identity a fresh cluster of its own', unlinkGivesTheIdentityAClusterOfItsOwn],
  ['unlink refuses an identity nobody linked', unlinkRefusesAnIdentityNobodyLinked],
  ['link to a directory person records the person', linkToADirectoryPersonRecordsThePerson],
];
