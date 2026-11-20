import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';
import type { ChatAgent, ChatAgentBundle, ChatStreamEvent } from '@omadia/channel-sdk';
import { buildSystemNotice } from '@omadia/orchestrator';

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-api-key-auth/src/rateLimiter.js';
import { createApiChatRouter } from '../../packages/harness-channel-api/src/chatRouter.js';
import { channelKeyOf } from '../../packages/harness-channel-api/src/channelKey.js';
import { managementChatAgent } from '../../packages/harness-orchestrator/src/management/managementChatAgent.js';
import { createCoreApi } from '../../src/channels/coreApi.js';
import { createOrchestratorDispatcher } from '../../src/channels/orchestratorDispatcher.js';
import { deriveChannelType } from '../../src/channels/channelType.js';
import { createInProcessClient } from '../support/inProcessHttp.js';
import { createFakeSecrets } from './testSecrets.js';

/**
 * #1106 end-to-end routing (suggested regression tests 2 & 3): a turn made with
 * an API key must reach the agent an operator BOUND to that key. Since #2055
 * there is no fallback agent: a key the management layer refuses gets the
 * `system` notice, and only a deployment WITHOUT a resolver (Postgres-less)
 * takes the static dispatch_service. This wires the REAL path a live turn takes —
 * `createApiChatRouter` → `createCoreApi` → `createOrchestratorDispatcher` —
 * with the real `deriveChannelType` (the value an operator binds under) and a
 * spy `resolveBinding` standing in for the multi-orchestrator channelResolver.
 *
 * Using the real `deriveChannelType` also guards the latent fragility the
 * plugin only documents: the directory advertises `channelType = ctx.agentId`,
 * but routing derives the type from the channelId — if those two ever diverge
 * (a `channel_type:` added to the manifest, a channelId rename) a bound row
 * would silently stop matching. This test asserts the resolver sees exactly the
 * `(channelType, channelKey)` an operator would have bound.
 */

const CHANNEL_ID = '@omadia/channel-api';

function tagAgent(tag: string): ChatAgent {
  return {
    chat: () => Promise.resolve({ text: tag }),
    async *chatStream() {
      const done: ChatStreamEvent = {
        type: 'done',
        answer: tag,
        toolCalls: 0,
        iterations: 1,
      } as ChatStreamEvent;
      yield done;
    },
  } as unknown as ChatAgent;
}

function parseNdjson(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function startServer(deps: {
  resolveBinding: (channelType: string, channelKey: string) => ChatAgent | undefined;
  fallback: ChatAgent;
}) {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const auditLog = createAuditLog(secrets);
  const rateLimiter = createRateLimiter();

  const dispatcher = createOrchestratorDispatcher({
    // No manifest block → dispatch_service defaults to the shared chatAgent, so
    // the per-binding routing path (US7) is the one under test.
    getChannelBlock: () => undefined,
    getAgentBundle: () => ({ agent: deps.fallback }) as unknown as ChatAgentBundle,
    channelTypeFor: (channelId) => deriveChannelType(channelId),
    resolveBinding: deps.resolveBinding,
  });
  const core = createCoreApi({
    dispatcher,
    // handleTurnStream is the only surface exercised here; the route registry
    // is unused (the router is mounted on express directly).
    routes: { register() {}, registerRouter() {} } as never,
  });

  const app = express();
  app.use(express.json());
  app.use(
    createApiChatRouter({ channelId: CHANNEL_ID, core, apiKeys, rateLimiter, auditLog }),
  );
  return { client: createInProcessClient(app), apiKeys };
}

describe('channelApi — end-to-end binding routing (#1106)', () => {
  it('routes a turn to the agent bound to the key, and passes the operator-bound (channelType, key:<uuid>)', async () => {
    const seen: Array<[string, string]> = [];
    const bound = tagAgent('bound-agent');
    const fallback = tagAgent('fallback-agent');
    const { client, apiKeys } = startServer({
      fallback,
      resolveBinding: (channelType, channelKey) => {
        seen.push([channelType, channelKey]);
        return bound;
      },
    });
    const key = await apiKeys.create({ label: 'bound' });

    const res = await client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi', conversationId: 'c1' }),
    });
    const done = parseNdjson(await res.text()).find((e) => e['type'] === 'done');

    assert.equal(done?.['answer'], 'bound-agent', 'the bound agent handled the turn');
    // The exact pair an operator binds — real deriveChannelType(channelId) plus
    // the stable per-key selector. Guards both the routing claim AND the
    // directory/routing channelType equality.
    assert.deepEqual(seen, [[deriveChannelType(CHANNEL_ID), channelKeyOf(key.record.id)]]);
    assert.equal(seen[0]?.[0], '@omadia/channel-api');
    assert.equal(seen[0]?.[1], channelKeyOf(key.record.id));
  });

  it('a key the management layer refuses gets the system notice, not the shared agent', async () => {
    const shared = tagAgent('shared-agent');
    const notice = buildSystemNotice('no_agent', { locale: 'en' });
    // What the channelResolver hands out on `reject`: the management layer
    // with no agent behind it, answering with the refusal.
    const { client, apiKeys } = startServer({
      fallback: shared,
      resolveBinding: (channelType, channelKey) =>
        managementChatAgent(undefined, { channelType, conversationKey: channelKey }, notice),
    });
    const key = await apiKeys.create({ label: 'unbound' });

    const res = await client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    const done = parseNdjson(await res.text()).find((e) => e['type'] === 'done');

    assert.equal(done?.['answer'], notice.text, 'the notice is the answer');
    assert.notEqual(done?.['answer'], 'shared-agent');
  });

  it('without a resolver answer (Postgres-less) the static dispatch_service serves', async () => {
    const fallback = tagAgent('fallback-agent');
    const { client, apiKeys } = startServer({
      fallback,
      // No resolver answer → the dispatcher takes the static dispatch_service.
      resolveBinding: () => undefined,
    });
    const key = await apiKeys.create({ label: 'unbound' });

    const res = await client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    const done = parseNdjson(await res.text()).find((e) => e['type'] === 'done');

    assert.equal(done?.['answer'], 'fallback-agent', 'served by the static dispatch_service');
  });
});
