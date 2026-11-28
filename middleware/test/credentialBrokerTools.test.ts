/**
 * #2319 / ADR-0290 / ADR-0355 — the kernel capability `credentialBroker@1`:
 * `credential_request` and `credential_ask` run in the calling agent's turn,
 * as the turn's account, only for credentials granted to that agent.
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryCredentialStore, makePrincipal, type EncryptedSecretMaterial, type Principal } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { turnContext, type TurnContextValue } from '@omadia/orchestrator';

import { InMemoryCredentialAskStore } from '../src/credentials/asks.js';
import {
  AgentCredentialGrantSnapshot,
  InMemoryAgentCredentialGrantStore,
  InMemoryCredentialAskDeliveryStore,
} from '../src/credentials/agentCredentialGrants.js';
import { CredentialBroker, type BrokerFetch } from '../src/credentials/broker.js';
import type { CredentialAskNotices } from '../src/credentials/credentialAskNotices.js';
import {
  CREDENTIAL_TOOL_MAX_BODY_CHARS,
  createCredentialAskHandler,
  createCredentialRequestHandler,
  credentialToolsOffered,
  type CredentialBrokerToolDeps,
} from '../src/credentials/credentialBrokerTools.js';
import { brokerAuditEntry } from '../src/credentials/credentialBrokerWiring.js';
import {
  resolveTurnOwnerIdentity,
  turnAccountUserId,
} from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';

const seal = (plaintext: string): EncryptedSecretMaterial => ({
  iv: 'iv',
  tag: 'tag',
  ciphertext: Buffer.from(plaintext, 'utf8').toString('base64'),
});
const unseal = (m: EncryptedSecretMaterial): string => Buffer.from(m.ciphertext, 'base64').toString('utf8');

const ACCOUNT = 'acct-cluster-anna';
const ANNA = makePrincipal('user', ACCOUNT) as Principal;
const OWNER = makePrincipal('user', 'acct-cluster-otto') as Principal;
const AGENT = { id: '00000000-0000-4000-8000-0000000000a1', slug: 'clara', name: 'Clara' };
const SECRET = 'svc-secret-value-123';

interface FetchCall {
  readonly url: string;
}

interface Harness {
  readonly deps: CredentialBrokerToolDeps;
  readonly credentials: InMemoryCredentialStore;
  readonly grants: InMemoryAgentCredentialGrantStore;
  readonly snapshot: AgentCredentialGrantSnapshot;
  readonly deliveries: InMemoryCredentialAskDeliveryStore;
  readonly notified: string[];
  readonly calls: FetchCall[];
  respond: (url: string) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  const credentials = new InMemoryCredentialStore(seal, unseal);
  const grants = new InMemoryAgentCredentialGrantStore();
  const snapshot = new AgentCredentialGrantSnapshot(grants);
  const deliveries = new InMemoryCredentialAskDeliveryStore();
  const notified: string[] = [];
  const calls: FetchCall[] = [];
  const h: Harness = {
    credentials,
    grants,
    snapshot,
    deliveries,
    notified,
    calls,
    respond: async () =>
      new Response(`{"ok":true,"echo":"${SECRET}"}`, {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc', 'x-internal': '1' },
      }),
    deps: undefined as unknown as CredentialBrokerToolDeps,
  };
  const fetchImpl: BrokerFetch = async (url) => {
    calls.push({ url });
    return (await h.respond(url)) as unknown as Awaited<ReturnType<BrokerFetch>>;
  };
  const notices: Pick<CredentialAskNotices, 'notifyOwner'> = {
    notifyOwner: async (ask) => {
      notified.push(ask.id);
      return true;
    },
  };
  (h as { deps: CredentialBrokerToolDeps }).deps = {
    broker: new CredentialBroker({ store: credentials, unseal, fetchImpl }),
    credentials,
    grants,
    snapshot,
    asks: new InMemoryCredentialAskStore(credentials),
    deliveries,
    notices,
    agentBySlug: (slug) => (slug === AGENT.slug ? AGENT : undefined),
    currentConversation: () => ({ channel: 'telegram', conversationRef: { chatId: '42' } }),
  };
  return h;
}

async function serviceCredential(h: Harness, name = 'github'): Promise<string> {
  const cred = await h.credentials.createCredential({
    name,
    kind: 'service',
    secret: SECRET,
    createdBy: 'op',
    broker: { host: 'api.example.com', injectionScheme: 'bearer', allowedMethods: ['GET', 'POST'], pathPrefixes: ['/v1'] },
  });
  return cred.id;
}

async function personalCredential(h: Harness, name = 'otto-token'): Promise<string> {
  const cred = await h.credentials.createCredential({ name, kind: 'personal', owner: OWNER, secret: SECRET, createdBy: 'op' });
  return cred.id;
}

function inTurn<T>(fn: () => Promise<T>, extra: Partial<TurnContextValue> = {}): Promise<T> {
  return turnContext.run(
    { turnId: 't1', turnDate: '2026-11-28', agentSlug: AGENT.slug, accountUserId: ACCOUNT, ...extra } as TurnContextValue,
    fn,
  );
}

const request = { credential: 'github', host: 'api.example.com', method: 'GET', path: '/v1/repos' };

describe('#2319 · credential_request', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('is offered only to an agent holding a credential grant', async () => {
    const id = await serviceCredential(h);
    assert.equal(await inTurn(async () => credentialToolsOffered(h.deps)), false);
    await h.grants.put(AGENT.id, id, 'op');
    await h.snapshot.refresh();
    assert.equal(await inTurn(async () => credentialToolsOffered(h.deps)), true);
    assert.equal(credentialToolsOffered(h.deps), false, 'no turn, no offer');
  });

  it('calls the broker as the turn account and returns status, content type and a scrubbed body only', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    await h.credentials.createGrant({ credentialId: id, principal: ANNA, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    const out = JSON.parse(await inTurn(() => createCredentialRequestHandler(h.deps)(request))) as Record<string, unknown>;
    assert.equal(out['status'], 200);
    assert.deepEqual(out['headers'], { 'content-type': 'application/json' });
    assert.equal(String(out['body']).includes(SECRET), false);
    assert.equal(h.calls.length, 1);
  });

  it('refuses a turn that speaks for no account, before anything is looked up', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const out = await inTurn(() => createCredentialRequestHandler(h.deps)(request), { accountUserId: undefined });
    assert.match(out, /^Error: \(account_not_linked\)/);
    assert.equal(h.calls.length, 0);
  });

  it('refuses a principal named in the input', async () => {
    const out = await inTurn(() => createCredentialRequestHandler(h.deps)({ ...request, principal: 'user:otto' }));
    assert.match(out, /^Error: \(identity_from_turn\)/);
  });

  it('refuses outside an agent turn', async () => {
    assert.match(await createCredentialRequestHandler(h.deps)(request), /^Error: \(no_turn\)/);
  });

  it('refuses a credential not granted to this agent and names only the granted ones', async () => {
    await serviceCredential(h, 'github');
    const other = await serviceCredential(h, 'jira');
    await h.grants.put(AGENT.id, other, 'op');
    const out = await inTurn(() => createCredentialRequestHandler(h.deps)(request));
    assert.match(out, /^Error: \(not_granted\)/);
    assert.match(out, /"jira"/);
    assert.equal(h.calls.length, 0);
  });

  it('needs the account\'s own credential grant on top of the agent grant (ADR-0102)', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const out = await inTurn(() => createCredentialRequestHandler(h.deps)(request));
    assert.match(out, /^Error: \(denied:no-active-grant\)/);
    assert.equal(h.calls.length, 0);
  });

  it('caps the body the model sees', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    await h.credentials.createGrant({ credentialId: id, principal: ANNA, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    h.respond = async () => new Response('x'.repeat(CREDENTIAL_TOOL_MAX_BODY_CHARS + 10), { status: 200 });
    const out = JSON.parse(await inTurn(() => createCredentialRequestHandler(h.deps)(request))) as Record<string, unknown>;
    assert.equal(String(out['body']).length, CREDENTIAL_TOOL_MAX_BODY_CHARS);
    assert.equal(out['truncated'], true);
  });

  it('reports a dispatched request without an answer as outcome unknown, not as a refusal', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    await h.credentials.createGrant({ credentialId: id, principal: ANNA, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    h.respond = async () => {
      throw new TypeError('fetch failed');
    };
    const out = JSON.parse(await inTurn(() => createCredentialRequestHandler(h.deps)({ ...request, method: 'POST', body: '{}' }))) as Record<string, unknown>;
    assert.equal(out['status'], 'outcome_unknown');
  });
});

describe('#2319 · credential_ask', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('creates a pending ask as the turn account, stores the reply target and notifies the owner once', async () => {
    const id = await personalCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const ask = createCredentialAskHandler(h.deps);
    const first = JSON.parse(await inTurn(() => ask({ credential: 'otto-token', purpose: 'read my calendar' }))) as Record<string, unknown>;
    assert.equal(first['status'], 'pending');
    const askId = String(first['askId']);
    const stored = await h.deps.asks.listForRequester(ANNA);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.mode, 'once');
    assert.ok(stored[0]?.requestedGrantExpiresAt);
    assert.equal(stored[0]?.requestedGrantValidSeconds, 3600);
    assert.deepEqual(h.notified, [askId]);
    // A second ask while one is pending returns the same ask and sends no second notice.
    const second = JSON.parse(await inTurn(() => ask({ credential: 'otto-token', purpose: 'again' }))) as Record<string, unknown>;
    assert.equal(second['askId'], askId);
    assert.deepEqual(h.notified, [askId]);
    const delivery = await h.deliveries.take(askId);
    assert.deepEqual(delivery, { askId, agentId: AGENT.id, channel: 'telegram', conversationRef: { chatId: '42' } });
  });

  it('creates one ask for parallel calls of one model message', async () => {
    const id = await personalCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const ask = createCredentialAskHandler(h.deps);
    const outs = await inTurn(() =>
      Promise.all([1, 2, 3].map(() => ask({ credential: 'otto-token', purpose: 'read my calendar' }))),
    );
    const ids = new Set(outs.map((o) => (JSON.parse(o) as { askId: string }).askId));
    assert.equal(ids.size, 1);
    assert.equal(h.notified.length, 1);
    assert.equal((await h.deps.asks.listForRequester(ANNA)).length, 1);
  });

  it('refuses a service credential: it has no owner to ask', async () => {
    const id = await serviceCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const out = await inTurn(() => createCredentialAskHandler(h.deps)({ credential: 'github', purpose: 'x' }));
    assert.match(out, /^Error: \(not_askable\)/);
  });

  it('refuses without an account and with an invalid validity', async () => {
    const id = await personalCredential(h);
    await h.grants.put(AGENT.id, id, 'op');
    const ask = createCredentialAskHandler(h.deps);
    assert.match(
      await inTurn(() => ask({ credential: 'otto-token', purpose: 'x' }), { accountUserId: undefined }),
      /^Error: \(account_not_linked\)/,
    );
    assert.match(await inTurn(() => ask({ credential: 'otto-token', purpose: 'x', valid_minutes: 0 })), /^Error: \(invalid\)/);
    assert.deepEqual(h.notified, []);
  });
});

describe('ADR-0355 · the account a turn speaks for', () => {
  it('is the session account on a web turn', () => {
    const input = { userId: ACCOUNT, origin: { channelType: 'http', scope: { kind: 'personal', userId: ACCOUNT }, conversationType: 'direct' } } as Parameters<typeof turnAccountUserId>[0];
    assert.equal(turnAccountUserId(input, {}), ACCOUNT);
  });

  it('is the linked account on a channel turn and nothing for an unlinked one', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const web = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'users-id-1', emailVerified: true });
    const turn = {
      userId: 'telegram:4711',
      origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4711' } },
    } as Parameters<typeof resolveTurnOwnerIdentity>[1];
    assert.equal(turnAccountUserId(turn, await resolveTurnOwnerIdentity(kg, turn)), undefined);
    await kg.linkChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
      target: { omadiaUserId: web.omadiaUserId, userId: 'users-id-1' },
    });
    assert.equal(turnAccountUserId(turn, await resolveTurnOwnerIdentity(kg, turn)), web.omadiaUserId);
  });

  it('is nothing for a channel identity linked to a disabled account', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const web = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'users-id-2', emailVerified: true });
    const turn = {
      userId: 'telegram:4712',
      origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4712' } },
    } as Parameters<typeof resolveTurnOwnerIdentity>[1];
    await kg.linkChannelIdentity({ channelKind: 'telegram', channelUserId: 'telegram:4712', target: { omadiaUserId: web.omadiaUserId, userId: 'users-id-2' } });
    const directory = {
      isAccountActive: async () => false,
      activePersonKeyByObjectId: async () => undefined,
      activePersonKeyById: async () => undefined,
    };
    assert.equal(turnAccountUserId(turn, await resolveTurnOwnerIdentity(kg, turn, directory)), undefined);
  });

  it('is the linked account on a minted channel identity too', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const web = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'users-id-3', emailVerified: true });
    await kg.resolveOrCreateChannelIdentity({ channelKind: 'slack', channelUserId: 'U77' });
    await kg.linkChannelIdentity({ channelKind: 'slack', channelUserId: 'U77', target: { omadiaUserId: web.omadiaUserId, userId: 'users-id-3' } });
    const turn = { userId: 'U77', channelIdentity: { channelKind: 'slack', channelUserId: 'U77' } } as Parameters<typeof resolveTurnOwnerIdentity>[1];
    const owner = await resolveTurnOwnerIdentity(kg, turn);
    assert.equal(owner.linkedUserId, 'users-id-3');
    assert.equal(turnAccountUserId(turn, owner), web.omadiaUserId);
  });

  it('is nothing for an HTTP turn without the session origin', () => {
    assert.equal(turnAccountUserId({ userId: 'whoever' } as Parameters<typeof turnAccountUserId>[0], { omadiaUserId: 'whoever' }), undefined);
  });
});

describe('#2319 · broker audit rows', () => {
  it('carry the decision, never a query string or the secret', () => {
    const entry = brokerAuditEntry(
      { kind: 'deny', credentialId: 'c1', principal: ANNA, host: 'api.example.com', method: 'GET', path: '/v1/x', reason: 'no-active-grant' },
      'clara',
    );
    assert.equal(entry.action, 'credential.broker_use');
    assert.equal(entry.target, 'credential:c1');
    assert.deepEqual(entry.after, {
      decision: 'deny',
      principal: `user:${ACCOUNT}`,
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/x',
      agent: 'clara',
      reason: 'no-active-grant',
    });
  });
});
