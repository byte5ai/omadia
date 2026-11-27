/**
 * #2324 / ADR-0302 and ADR-0300 — the turn owner with the kernel's
 * `turnIdentityDirectory@1`: a link to a disabled account is not applied, a
 * Teams sender who is an active directory person keys `per_user` tokens on
 * their object id, and a channel identity linked to a directory person runs
 * as the person's cluster while the person is active.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import {
  channelTurnMcpUserKey,
  resolveTurnOwnerIdentity,
  type TurnIdentityDirectory,
} from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';

const ACCOUNT = '7d1c2b3a-0000-4000-8000-00000000a001';
const OID = '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const PERSON = '9a8b7c6d-0000-4000-8000-00000000b001';

type Turn = Parameters<typeof resolveTurnOwnerIdentity>[1];

const telegramTurn = {
  userId: 'telegram:4711',
  origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4711' } },
} as Turn;

const teamsTurn = {
  userId: OID,
  origin: { channelType: 'teams', scope: { kind: 'personal', userId: OID } },
} as Turn;

function directory(opts: {
  accountActive?: boolean;
  personActive?: boolean;
}): TurnIdentityDirectory {
  return {
    isAccountActive: async () => opts.accountActive ?? true,
    activePersonKeyByObjectId: async (oid) => (opts.personActive && oid === OID ? OID : undefined),
    activePersonKeyById: async (id) => (opts.personActive && id === PERSON ? OID : undefined),
  };
}

async function accountLinkedGraph(): Promise<InMemoryKnowledgeGraph> {
  const kg = new InMemoryKnowledgeGraph();
  const web = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ACCOUNT,
    email: 'anna@example.com',
    emailVerified: true,
    authSubject: { provider: 'local', providerUserId: 'anna@example.com' },
  });
  await kg.linkChannelIdentity({
    channelKind: 'telegram',
    channelUserId: 'telegram:4711',
    target: { omadiaUserId: web.omadiaUserId, userId: ACCOUNT },
  });
  return kg;
}

describe('#2324 · a link to a disabled account is not applied', () => {
  it('runs as the account while it is active', async () => {
    const kg = await accountLinkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn, directory({ accountActive: true }));
    assert.equal(owner.linkedUserId, ACCOUNT);
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), 'anna@example.com');
  });

  it('runs as the raw channel id while the account is disabled, without an MCP key', async () => {
    const kg = await accountLinkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn, directory({ accountActive: false }));
    assert.equal(owner.linkedUserId, undefined);
    assert.equal(owner.omadiaUserId, 'telegram:4711');
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), undefined);
  });

  it('treats a failing account lookup as inactive', async () => {
    const kg = await accountLinkedGraph();
    const failing: TurnIdentityDirectory = {
      ...directory({}),
      isAccountActive: async () => {
        throw new Error('db down');
      },
    };
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn, failing);
    assert.equal(owner.linkedUserId, undefined);
  });
});

describe('ADR-0300 · Teams senders who are directory people', () => {
  it('keys per_user tokens on the object id of an active person', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await resolveTurnOwnerIdentity(kg, teamsTurn, directory({ personActive: true }));
    assert.equal(owner.directoryPersonKey, OID);
    // The turn itself keeps its raw id (ADR-0280: unlinked turns do not change).
    assert.equal(owner.omadiaUserId, OID);
    assert.equal(channelTurnMcpUserKey(teamsTurn, owner), OID);
  });

  it('produces no key for a sender the directory does not list as active', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await resolveTurnOwnerIdentity(kg, teamsTurn, directory({ personActive: false }));
    assert.equal(owner.directoryPersonKey, undefined);
    assert.equal(channelTurnMcpUserKey(teamsTurn, owner), undefined);
  });

  it('produces no key without a directory', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await resolveTurnOwnerIdentity(kg, teamsTurn);
    assert.equal(channelTurnMcpUserKey(teamsTurn, owner), undefined);
  });

  it('does not key a Telegram sender on the directory by its own id', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const forged = { ...telegramTurn, userId: OID } as Turn;
    const owner = await resolveTurnOwnerIdentity(kg, forged, directory({ personActive: true }));
    assert.equal(owner.directoryPersonKey, undefined);
  });
});

describe('ADR-0300 · a channel identity linked to a directory person', () => {
  async function personLinkedGraph(): Promise<{ kg: InMemoryKnowledgeGraph; cluster: string }> {
    const kg = new InMemoryKnowledgeGraph();
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: OID,
      aadObjectId: OID,
    });
    await kg.linkChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
      target: { omadiaUserId: teams.omadiaUserId, directoryPersonId: PERSON },
    });
    return { kg, cluster: teams.omadiaUserId };
  }

  it('runs as the person cluster and keys on the person while active', async () => {
    const { kg, cluster } = await personLinkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn, directory({ personActive: true }));
    assert.equal(owner.omadiaUserId, cluster);
    assert.equal(owner.linkedDirectoryPersonId, PERSON);
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), OID);
  });

  it('runs as the raw id once the person is deprovisioned', async () => {
    const { kg } = await personLinkedGraph();
    const owner = await resolveTurnOwnerIdentity(kg, telegramTurn, directory({ personActive: false }));
    assert.equal(owner.omadiaUserId, 'telegram:4711');
    assert.equal(channelTurnMcpUserKey(telegramTurn, owner), undefined);
  });

  it('the identity reports the person link and unlinks like an account link', async () => {
    const { kg } = await personLinkedGraph();
    const resolved = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: 'telegram:4711' });
    assert.equal(resolved.linkedDirectoryPersonId, PERSON);
    assert.equal(resolved.linkedUserId, undefined);
    await kg.linkChannelIdentity({ channelKind: 'telegram', channelUserId: 'telegram:4711', target: null });
    const after = await kg.resolveOrCreateChannelIdentity({ channelKind: 'telegram', channelUserId: 'telegram:4711' });
    assert.equal(after.linkedDirectoryPersonId, undefined);
  });

  it('refuses a link target that names neither an account nor a person', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const teams = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: OID, aadObjectId: OID });
    await assert.rejects(
      kg.linkChannelIdentity({
        channelKind: 'telegram',
        channelUserId: 'telegram:4711',
        target: { omadiaUserId: teams.omadiaUserId },
      }),
      /invalid_link_target/,
    );
  });
});

describe('#2324 / ADR-0300 · minted channel identities (dispatcher userRef path)', () => {
  const minted = {
    userId: 'telegram:4711',
    channelIdentity: { channelKind: 'telegram', channelUserId: 'telegram:4711' },
  } as Turn;

  it('a link to a disabled account gives the turn no identity', async () => {
    const kg = await accountLinkedGraph();
    const active = await resolveTurnOwnerIdentity(kg, minted, directory({ accountActive: true }));
    assert.equal(channelTurnMcpUserKey(minted, active), 'anna@example.com');
    const disabled = await resolveTurnOwnerIdentity(kg, minted, directory({ accountActive: false }));
    assert.deepEqual(disabled, {});
    assert.equal(channelTurnMcpUserKey(minted, disabled), undefined);
  });

  it('a person link keys on the person while active, and on nobody after', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const teams = await kg.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: OID, aadObjectId: OID });
    await kg.linkChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
      target: { omadiaUserId: teams.omadiaUserId, directoryPersonId: PERSON },
    });
    const active = await resolveTurnOwnerIdentity(kg, minted, directory({ personActive: true }));
    assert.equal(active.omadiaUserId, teams.omadiaUserId);
    assert.equal(channelTurnMcpUserKey(minted, active), OID);
    const gone = await resolveTurnOwnerIdentity(kg, minted, directory({ personActive: false }));
    assert.deepEqual(gone, {});
  });

  it('a minted Teams identity of an active person keys on the object id', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const teams = { userId: OID, channelIdentity: { channelKind: 'teams', channelUserId: OID } } as Turn;
    const owner = await resolveTurnOwnerIdentity(kg, teams, directory({ personActive: true }));
    assert.equal(owner.directoryPersonKey, OID);
  });
});

