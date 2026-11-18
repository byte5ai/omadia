/**
 * The public API-key stream forwards the verifier's trailing `verifier` event
 * verbatim, so what that event says is what third-party clients read. A
 * verifier that could not run must say `unavailable` on the wire — not
 * `approved` / `verified` — and must not put its error text there.
 *
 * Drives the REAL `createApiChatRouter` over a REAL `VerifierService`; only the
 * orchestrator (one scripted `done`) and the pipeline (the verdict source) are
 * stubbed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';
import type { IncomingTurn } from '@omadia/channel-sdk';
import type { VerifierPipeline, VerifierVerdict } from '@omadia/verifier';

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-api-key-auth/src/rateLimiter.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { createApiChatRouter } from '../../packages/harness-channel-api/src/chatRouter.js';
import type { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { VerifierService } from '../../packages/harness-orchestrator/src/verifierService.js';
import { createInProcessClient } from '../support/inProcessHttp.js';
import { createFakeSecrets } from './testSecrets.js';

async function verifierEventOnTheWire(
  verify: () => Promise<VerifierVerdict>,
): Promise<{ verifier: Record<string, unknown> | undefined; body: string }> {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const orchestrator = {
    agentId: 'default',
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      await Promise.resolve();
      yield { type: 'done', answer: 'Die Rechnung beträgt 1.234,56 €.', toolCalls: 1, iterations: 1 };
    },
  } as unknown as Orchestrator;
  const service = new VerifierService({
    orchestrator,
    pipeline: { verify } as unknown as VerifierPipeline,
    enabled: true,
    mode: 'shadow',
    log: () => undefined,
  });

  const app = express();
  app.use(express.json());
  app.use(
    createApiChatRouter({
      channelId: '@omadia/channel-api',
      apiKeys,
      auditLog: createAuditLog(secrets),
      rateLimiter: createRateLimiter(),
      core: {
        handleTurnStream(turn: IncomingTurn) {
          return service.chatStream({ userMessage: turn.text, sessionScope: turn.conversationId });
        },
      },
    }),
  );
  const client = createInProcessClient(app);
  const created = await apiKeys.create({ label: 'verifier-states' });
  const res = await client.fetch('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
    body: JSON.stringify({ message: 'Wie hoch ist die Rechnung?', conversationId: 'conv-states' }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  const events = body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const verifier = events.find((e) => e['type'] === 'verifier');
  return {
    verifier: verifier?.['summary'] as Record<string, unknown> | undefined,
    body,
  };
}

describe('channelApi/chatRouter — verifier states on the public stream', () => {
  it('a pipeline failure reaches API clients as unavailable, with no error text', async () => {
    const { verifier, body } = await verifierEventOnTheWire(() =>
      Promise.reject(new Error('upstream refused: token-abc123 at llm.example.invalid')),
    );
    assert.ok(verifier, 'the stream carries a verifier event');
    assert.equal(verifier['status'], 'unavailable');
    assert.equal(verifier['badge'], 'unavailable');
    assert.equal(verifier['claimCount'], 0);
    assert.equal(verifier['reason'], 'pipeline_error');
    assert.doesNotMatch(body, /token-abc123|llm\.example\.invalid|upstream refused/);
  });

  it('a turn with nothing checkable reaches API clients as skipped / unverified', async () => {
    const { verifier } = await verifierEventOnTheWire(() =>
      Promise.resolve({ status: 'skipped', reason: 'no_trigger', claims: [], latencyMs: 1 }),
    );
    assert.ok(verifier);
    assert.equal(verifier['status'], 'skipped');
    assert.equal(verifier['badge'], 'unverified');
    assert.equal(verifier['reason'], 'no_trigger');
  });
});
