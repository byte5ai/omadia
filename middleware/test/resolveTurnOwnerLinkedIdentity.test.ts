/**
 * ADR-0225 — a plugin channel turn (Telegram: `origin` + `userId`, no minted
 * `channelIdentity`) runs as the account an operator linked its sender to,
 * and as the raw channel id while unlinked.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { makePrincipal } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import {
  channelTurnMcpUserKey,
  resolveRunTraceOwner,
  resolveTurnOwnerIdentity,
} from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';

const ACCOUNT = '7d1c2b3a-0000-4000-8000-00000000a001';

const telegramTurn = {
  userId: 'telegram:4711',
  origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4711' } },
} as Parameters<typeof resolveTurnOwnerIdentity>[1];

async function linkedGraph(): Promise<{ kg: InMemoryKnowledgeGraph; account: string }> {
  const kg = new InMemoryKnowledgeGraph();
  const web = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ACCOUNT,
    email: 'anna@example.com',
    emailVerified: true,
    authSubject: { provider: 'local', providerUserId: 'anna@example.com' },
  });
  return { kg, account: web.omadiaUserId };
}

describe('ADR-0225 · turn identity of a linked channel account', () => {
  it('an unlinked Telegram turn keeps running as its raw channel id', async () => {
    const { kg } = await linkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn);
    assert.equal(owner.omadiaUserId, 'telegram:4711');
    assert.deepEqual(owner.principal, makePrincipal('user', 'telegram:4711'));
    assert.equal(owner.linkedUserId, undefined);
    assert.equal(owner.authSubjectKey, undefined);
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), undefined);
    // The run trace still files under the identity's own cluster, resolved once.
    const cluster = await kg.findOmadiaUserIdByChannelIdentity('telegram', 'telegram:4711');
    assert.equal(owner.originClusterUserId, cluster);
    assert.equal(await resolveRunTraceOwner(kg, telegramTurn, owner.omadiaUserId, owner.originClusterUserId), cluster);
  });

  it('a linked Telegram turn runs as the account cluster, with its IdP subject as MCP key', async () => {
    const { kg, account } = await linkedGraph();
    await kg.linkChannelIdentity({
      channelKind: 'telegram',
      // The id the turns carry (`ChatTurnInput.userId`), which keys the identity.
      channelUserId: 'telegram:4711',
      target: { omadiaUserId: account, userId: ACCOUNT },
    });
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn);
    assert.equal(owner.omadiaUserId, account);
    assert.deepEqual(owner.principal, makePrincipal('user', account));
    assert.equal(owner.linkedUserId, ACCOUNT);
    assert.equal(owner.authSubjectKey, 'anna@example.com');
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), 'anna@example.com');
    assert.equal(await resolveRunTraceOwner(kg, telegramTurn, owner.omadiaUserId, owner.originClusterUserId), account);
  });

  it('a cluster joined by e-mail or AAD alone is not a link: the turn stays on its raw id', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: ACCOUNT, aadObjectId: 'aad-1' });
    const teamsTurn = {
      userId: 'aad-1',
      origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'aad-1' } },
    } as Parameters<typeof resolveTurnOwnerIdentity>[1];
    const owner = await resolveTurnOwnerIdentity(kg, teamsTurn);
    assert.equal(owner.omadiaUserId, 'aad-1');
    assert.equal(owner.linkedUserId, undefined);
  });

  it('a graph failure leaves the turn on its raw id', async () => {
    const failing = {
      resolveOrCreateChannelIdentity: async () => {
        throw new Error('db down');
      },
    } as unknown as Parameters<typeof resolveTurnOwnerIdentity>[0];
    const owner = await resolveTurnOwnerIdentity(failing, telegramTurn);
    assert.equal(owner.omadiaUserId, 'telegram:4711');
    assert.equal(owner.originClusterUserId, undefined);
  });

  it('without an origin the turn keeps its userId (HTTP path unchanged)', async () => {
    const { kg } = await linkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, { userId: ACCOUNT });
    assert.equal(owner.omadiaUserId, ACCOUNT);
    assert.equal(channelTurnMcpUserKey({}, owner), undefined);
  });
});
