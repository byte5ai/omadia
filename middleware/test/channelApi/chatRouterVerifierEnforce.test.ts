/**
 * The public API-key stream forwards whatever the chat agent yields. With the
 * answer verifier in `enforce` mode, an answer the verifier withheld must not
 * reach the wire at all — not as `text_delta` chunks before the verdict, not
 * in `done` — and the withheld turn must still read as a complete stream: one
 * notice delta, a `done` marked `answerSource: "verifier-blocked"`, then the
 * `verifier` event.
 *
 * Drives the REAL `createApiChatRouter` over a REAL `VerifierService`; only
 * the orchestrator (a scripted stream) and the pipeline are stubbed.
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
import { AMOUNT_TEXT, approved, blocked } from '../_helpers/verifierVerdictFixtures.js';
import { createFakeSecrets } from './testSecrets.js';

const ANSWER = `Der Umsatz beträgt ${AMOUNT_TEXT}.`;

async function enforcedWire(verdict: VerifierVerdict): Promise<Record<string, unknown>[]> {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const orchestrator = {
    agentId: 'default',
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      await Promise.resolve();
      yield { type: 'iteration_start', iteration: 1 };
      yield { type: 'text_delta', text: 'Der Umsatz beträgt ' };
      yield { type: 'text_delta', text: `${AMOUNT_TEXT}.` };
      yield { type: 'done', answer: ANSWER, toolCalls: 0, iterations: 1 };
    },
  } as unknown as Orchestrator;
  const service = new VerifierService({
    orchestrator,
    pipeline: { verify: () => Promise.resolve(verdict) } as unknown as VerifierPipeline,
    enabled: true,
    mode: 'enforce',
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
  const created = await apiKeys.create({ label: 'verifier-enforce' });
  const res = await client.fetch('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
    body: JSON.stringify({ message: 'Wie hoch war der Umsatz?', conversationId: 'conv-enforce' }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('channelApi/chatRouter — enforce-mode verifier on the public stream', () => {
  it('a withheld answer never reaches the wire; the notice does', async () => {
    const events = await enforcedWire(blocked());
    assert.equal(JSON.stringify(events).includes(AMOUNT_TEXT), false, 'the figure leaked');
    const deltas = events.filter((e) => e['type'] === 'text_delta');
    assert.equal(deltas.length, 1);
    const done = events.find((e) => e['type'] === 'done');
    assert.ok(done);
    assert.equal(done['answer'], deltas[0]?.['text']);
    assert.equal(done['answerSource'], 'verifier-blocked');
    assert.equal(done['answerIsError'], true);
    assert.deepEqual(done['provenance'], { aiGenerated: true }, 'the route still stamps provenance');
    assert.deepEqual(
      events.map((e) => e['type']),
      ['iteration_start', 'text_delta', 'done', 'verifier'],
    );
  });

  it('a confirmed answer reaches the wire with its verdict on done', async () => {
    const events = await enforcedWire(approved());
    const done = events.find((e) => e['type'] === 'done');
    assert.equal(done?.['answer'], ANSWER);
    assert.equal(done?.['answerSource'], undefined);
    assert.equal((done?.['verifier'] as Record<string, unknown> | undefined)?.['badge'], 'verified');
    assert.deepEqual(
      events.map((e) => e['type']),
      ['iteration_start', 'text_delta', 'text_delta', 'done', 'verifier'],
    );
  });
});
