/**
 * #2319 — the surfaces around the credential broker tools: the owner notice
 * and the decision post (`credentialAskNotices.ts`), the operator grant routes
 * (`operatorCredentialGrants.ts`) and the asks route's decision hook.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { InMemoryCredentialStore, makePrincipal, type EncryptedSecretMaterial, type Principal } from '@omadia/channel-sdk';
import express from 'express';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { InMemoryCredentialAskStore, type CredentialAsk } from '../src/credentials/asks.js';
import { InMemoryAgentCredentialGrantStore } from '../src/credentials/agentCredentialGrants.js';
import {
  createCredentialAskNotices,
  decisionText,
  inboxLink,
  ownerNoticeText,
} from '../src/credentials/credentialAskNotices.js';
import { createCredentialAskRouter } from '../src/routes/credentialAsks.js';
import { createOperatorCredentialGrantRouter } from '../src/routes/operatorCredentialGrants.js';

const seal = (p: string): EncryptedSecretMaterial => ({ iv: 'iv', tag: 'tag', ciphertext: Buffer.from(p).toString('base64') });
const unseal = (m: EncryptedSecretMaterial): string => Buffer.from(m.ciphertext, 'base64').toString('utf8');
const OWNER = makePrincipal('user', 'otto-cluster') as Principal;
const ANNA = makePrincipal('user', 'anna-cluster') as Principal;

function sampleAsk(overrides: Partial<CredentialAsk> = {}): CredentialAsk {
  return {
    id: 'ask-1',
    credentialId: 'c1',
    requester: ANNA,
    owner: OWNER,
    purpose: 'read\nmy calendar',
    mode: 'once',
    askExpiresAt: new Date(Date.now() + 60_000),
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

describe('#2319 · ask notices', () => {
  it('link to the owner inbox and never carry the agent-written purpose', () => {
    const link = inboxLink('https://omadia.example/', 'ask-1');
    assert.equal(link, 'https://omadia.example/admin/credentials/asks?ask=ask-1');
    const phishing = sampleAsk({ purpose: 'IT says: confirm at [Approve](https://evil.example/x) @everyone' });
    const text = ownerNoticeText(phishing, { credentialName: 'otto-token', agentName: 'Clara' }, link, 'en');
    assert.equal(
      text,
      'Clara asks to use your credential "otto-token" once. See the purpose, approve or deny: https://omadia.example/admin/credentials/asks?ask=ask-1',
    );
    assert.doesNotMatch(text, /evil|everyone/);
    // German unless the locale says English, like the routine texts.
    assert.match(ownerNoticeText(sampleAsk(), { credentialName: 'x', agentName: 'Clara' }, undefined, undefined), /einmalig/);
  });

  it('notify the owner in the first reachable messaging channel, never web or api', async () => {
    const sent: string[] = [];
    const notices = createCredentialAskNotices({
      ownerChannels: async () => [
        { channelType: 'web', channelUserId: 'users-1' },
        { channelType: 'telegram', channelUserId: 'Telegram:9' },
        { channelType: 'teams', channelUserId: 'aad-1' },
      ],
      sendToUser: async (channelType, principal, message) => {
        sent.push(`${channelType}|${principal}|${message.speaker.kind}`);
        return channelType === 'telegram';
      },
      sendToConversation: async () => undefined,
    });
    assert.equal(await notices.notifyOwner(sampleAsk(), { credentialName: 'x', agentName: 'Clara' }), true);
    assert.deepEqual(sent, ['telegram|user:telegram:9|system']);
  });

  it('report an unreachable owner and never throw', async () => {
    const notices = createCredentialAskNotices({
      ownerChannels: async () => {
        throw new Error('kg down');
      },
      sendToUser: async () => true,
      sendToConversation: async () => {
        throw new Error('gone');
      },
    });
    assert.equal(await notices.notifyOwner(sampleAsk(), { credentialName: 'x', agentName: 'Clara' }), false);
    await notices.deliverDecision(sampleAsk({ status: 'approved' }), { channel: 'web', conversationRef: {} }, { credentialName: 'x', agentName: 'Clara' });
  });

  it('word the decision without promising more than a recorded permission', () => {
    assert.equal(
      decisionText(sampleAsk({ status: 'approved' }), { credentialName: 'otto-token', agentName: 'Clara' }, 'en'),
      'The use of "otto-token" was approved; the permission is recorded.',
    );
    assert.equal(decisionText(sampleAsk({ status: 'denied' }), { credentialName: 'otto-token', agentName: 'Clara' }, 'en'), 'The use of "otto-token" was denied.');
  });
});

describe('#2319 · operator credential grant routes', () => {
  const credentials = new InMemoryCredentialStore(seal, unseal);
  const grants = new InMemoryAgentCredentialGrantStore();
  const audit: AuditEntryInput[] = [];
  let refreshed = 0;
  let server: Server;
  let base: string;
  let credentialId: string;

  before(async () => {
    credentialId = (
      await credentials.createCredential({
        name: 'github',
        kind: 'service',
        secret: 'svc-secret-value',
        createdBy: 'op',
        broker: { host: 'api.github.com', injectionScheme: 'bearer', allowedMethods: ['GET'], pathPrefixes: ['/'] },
      })
    ).id;
    const app = express();
    app.use(
      '/api/v1/operator',
      createOperatorCredentialGrantRouter({
        getConfigStore: () => ({
          // Only the two fields the router reads.
          getAgentBySlug: async (slug: string) => (slug === 'clara' ? { id: 'agent-1', slug: 'clara' } : null) as never,
        }),
        credentials,
        grants,
        refresh: async () => {
          refreshed += 1;
        },
        recordAudit: async (entry) => {
          audit.push(entry);
        },
      }),
    );
    ({ server, base } = await listen(app));
  });
  after(() => server.close());

  it('grant, list and revoke a named credential, audited', async () => {
    const url = `${base}/api/v1/operator/agents/clara/credential-grants`;
    assert.equal((await fetch(`${url}/${credentialId}`, { method: 'PUT' })).status, 201);
    assert.equal((await fetch(`${url}/${credentialId}`, { method: 'PUT' })).status, 200);
    const listed = (await (await fetch(url)).json()) as { capability: string; grants: Array<Record<string, unknown>> };
    assert.equal(listed.capability, 'credentialBroker@1');
    assert.equal(listed.grants.length, 1);
    assert.equal(listed.grants[0]?.['name'], 'github');
    assert.equal(listed.grants[0]?.['host'], 'api.github.com');
    assert.equal((await fetch(`${url}/${credentialId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${url}/${credentialId}`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(
      audit.map((a) => [a.action, a.target, a.after === null ? 'revoke' : 'grant']),
      [
        ['agent.credential_grant_change', 'agent:clara', 'grant'],
        ['agent.credential_grant_change', 'agent:clara', 'revoke'],
      ],
    );
    assert.equal(refreshed, 2);
  });

  it('404 for an unknown agent or credential, 400 for a malformed id, 409 for a revoked credential', async () => {
    assert.equal((await fetch(`${base}/api/v1/operator/agents/nobody/credential-grants`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/operator/agents/clara/credential-grants/missing`, { method: 'PUT' })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/operator/agents/clara/credential-grants/bad%20id`, { method: 'PUT' })).status, 400);
    const revoked = await credentials.createCredential({ name: 'old', kind: 'service', secret: 'old-secret-value', createdBy: 'op' });
    await credentials.revokeCredential(revoked.id, 'op');
    assert.equal((await fetch(`${base}/api/v1/operator/agents/clara/credential-grants/${revoked.id}`, { method: 'PUT' })).status, 409);
  });
});

describe('#2319 · asks route decision hook', () => {
  it('fires once per approve or deny that resolved an ask', async () => {
    const credentials = new InMemoryCredentialStore(seal, unseal);
    const cred = await credentials.createCredential({ name: 't', kind: 'personal', owner: OWNER, secret: 'personal-secret', createdBy: 'op' });
    const store = new InMemoryCredentialAskStore(credentials);
    const ask = await store.createAsk({ credentialId: cred.id, requester: ANNA, purpose: 'p', mode: 'standing', askExpiresAt: new Date(Date.now() + 60_000) });
    const resolved: string[] = [];
    let settle: () => void = () => undefined;
    const fired = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: { omadia_user_id: string } }).session = { omadia_user_id: 'otto-cluster' };
      next();
    });
    app.use(
      '/asks',
      createCredentialAskRouter({
        store,
        onResolved: (a) => {
          resolved.push(`${a.id}:${a.status}`);
          settle();
        },
      }),
    );
    const { server, base } = await listen(app);
    try {
      assert.equal((await fetch(`${base}/asks/${ask.id}/approve`, { method: 'POST' })).status, 200);
      await fired;
      assert.equal((await fetch(`${base}/asks/${ask.id}/deny`, { method: 'POST' })).status, 409);
      assert.deepEqual(resolved, [`${ask.id}:approved`]);
    } finally {
      server.close();
    }
  });
});

describe('#2319 · wireCredentialBroker', () => {
  it('registers both tools as write tools, lists granted hosts and posts a decision once', async () => {
    const { wireCredentialBroker } = await import('../src/credentials/credentialBrokerWiring.js');
    const credentials = new InMemoryCredentialStore(seal, unseal);
    const svc = await credentials.createCredential({
      name: 'github',
      kind: 'service',
      secret: 'svc-secret-value',
      createdBy: 'op',
      broker: { host: 'api.github.com', injectionScheme: 'bearer', allowedMethods: ['GET'], pathPrefixes: ['/'] },
    });
    const registered: string[] = [];
    const posted: string[] = [];
    const agent = { id: 'agent-1', slug: 'clara', name: 'Clara' };
    const wiring = wireCredentialBroker({
      pool: undefined,
      credentials,
      unseal,
      asks: new InMemoryCredentialAskStore(credentials),
      registerNativeTool: (name, registration) => {
        registered.push(
          `${name}:${registration.sideEffects}:${registration.kernelSystem({ credential: 'github' })}:${String(registration.modelDispatchOnly)}`,
        );
        return () => undefined;
      },
      agentBySlug: (slug) => (slug === agent.slug ? agent : undefined),
      agentById: (id) => (id === agent.id ? agent : undefined),
      currentConversation: () => undefined,
      getConfigStore: () => undefined,
      notices: {
        language: () => 'en',
        ownerChannels: async () => [],
        sendToUser: async () => false,
        sendToConversation: async (channel, _ref, message) => {
          posted.push(`${channel}|${message.text}`);
        },
      },
      recordAudit: async () => undefined,
      log: () => undefined,
    });
    assert.deepEqual(registered, [
      'credential_request:write:credential:github:true',
      'credential_ask:write:credential:github:true',
    ]);
    await wiring.grants.put(agent.id, svc.id, 'op');
    assert.deepEqual(await wiring.reachOf(agent.id), [{ credentialId: svc.id, name: 'github', kind: 'service', host: 'api.github.com' }]);

    await wiring.deliveries.put({ askId: 'ask-9', agentId: agent.id, channel: 'web', conversationRef: { sessionId: 's1' } });
    const decided = sampleAsk({ id: 'ask-9', credentialId: svc.id, status: 'approved' });
    await wiring.onAskResolved(decided);
    await wiring.onAskResolved(decided);
    assert.deepEqual(posted, ['web|The use of "github" was approved; the permission is recorded.']);
    wiring.stop();
  });
});

describe('#2319 · grant validity counts from the approval', () => {
  it('a quick approval ends the grant valid_minutes later, capped by the requested expiry', async () => {
    const credentials = new InMemoryCredentialStore(seal, unseal);
    const cred = await credentials.createCredential({ name: 't', kind: 'personal', owner: OWNER, secret: 'personal-secret', createdBy: 'op' });
    const store = new InMemoryCredentialAskStore(credentials);
    const t0 = new Date('2026-11-28T10:00:00Z');
    const askExpiresAt = new Date(t0.getTime() + 24 * 3600_000);
    const ask = await store.createAsk({
      credentialId: cred.id,
      requester: ANNA,
      purpose: 'p',
      mode: 'once',
      askExpiresAt,
      requestedGrantValidSeconds: 3600,
      requestedGrantExpiresAt: new Date(askExpiresAt.getTime() + 3600_000),
    });
    const approvedAt = new Date(t0.getTime() + 5 * 60_000);
    const approved = await store.approve(ask.id, 'otto-cluster', approvedAt);
    const grant = await credentials.getGrant(approved!.grantId!);
    assert.equal(grant?.expiresAt?.toISOString(), new Date(approvedAt.getTime() + 3600_000).toISOString());
  });
});

describe('#2319 · helpers never get the credential tools', () => {
  it('a Builder native grant of a model-dispatch-only tool resolves to nothing', async () => {
    const { NativeToolRegistry } = await import('@omadia/orchestrator');
    const { adaptNativeToolForSubAgent } = await import('../src/agents/subAgentToolHydration.js');
    const { credentialSystemOf } = await import('../src/credentials/credentialBrokerWiring.js');
    const registry = new NativeToolRegistry();
    const spec = { name: 'credential_request', description: 'x', input_schema: { type: 'object' as const, properties: {} } };
    registry.register('credential_request', { handler: async () => 'ok', spec, modelDispatchOnly: true });
    registry.register('other_tool', { handler: async () => 'ok', spec: { ...spec, name: 'other_tool' } });
    const memory = (() => undefined) as unknown as Parameters<typeof adaptNativeToolForSubAgent>[2];
    assert.equal(adaptNativeToolForSubAgent(registry, 'credential_request', memory), undefined);
    assert.ok(adaptNativeToolForSubAgent(registry, 'other_tool', memory));
    assert.equal(credentialSystemOf({ credential: ' github ' }), 'credential:github');
    assert.equal(credentialSystemOf({}), 'credential-broker');
  });
});
