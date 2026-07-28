/**
 * Issue #438 acceptance: "API chat responses pass through privacy-guard PII
 * masking the same way other channels' responses do — test asserts masking
 * actually ran (not just that the plugin was called)."
 *
 * Exercises the REAL orchestrator turn pipeline and the REAL privacy-guard
 * service (same construction as `test/orchestrator/promptMaskPipeline.test.ts`
 * — the established pattern in this repo for "real orchestrator, fake LLM")
 * wired through `createApiChatRouter`'s `core.handleTurnStream` seam, exactly
 * as `@omadia/channel-api`'s `plugin.ts` wires the real `CoreApi.handleTurnStream`.
 * No second/parallel masking path is built here — the plugin reuses whatever
 * `Orchestrator.chatStream` already does for every other channel.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { IncomingTurn } from '@omadia/channel-sdk';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import { createApiKeyStore } from '../../packages/harness-channel-api/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-channel-api/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-channel-api/src/rateLimiter.js';
import { createApiChatRouter } from '../../packages/harness-channel-api/src/chatRouter.js';
import { createFakeSecrets } from './testSecrets.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const RAW_EMAIL = 'anna.schmidt@firma.de';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The privacy-guard service with the #361 user-prompt-masking flag forced on. */
function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
  });
}

function finalResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Streaming fake: echoes back whatever email-shaped token IT SAW on the
 *  wire (the masked surrogate, if masking ran — the raw email otherwise). */
function echoingStreamProvider(requests: string[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: (): Promise<LlmResponse> => {
      throw new Error('echoingStreamProvider: complete() not scripted — chatStream uses stream()');
    },
    stream: async function* (req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const serialized = JSON.stringify(req);
      requests.push(serialized);
      const email = EMAIL_RE.exec(serialized)?.[0] ?? 'no-email-in-request';
      const text = `Notiert. Ich schreibe an ${email}.`;
      yield { type: 'text_delta', text };
      yield { type: 'final', response: finalResponse(text) };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function parseNdjson(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('channelApi/chatRouter — real orchestrator + real privacy-guard', () => {
  let server: Server;
  let baseUrl: string;
  let apiKeys: ReturnType<typeof createApiKeyStore>;
  const mainRequests: string[] = [];

  before(() => {
    const secrets = createFakeSecrets();
    apiKeys = createApiKeyStore(secrets);
    const auditLog = createAuditLog(secrets);
    const rateLimiter = createRateLimiter();

    const orchestrator = new Orchestrator({
      provider: echoingStreamProvider(mainRequests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: () => maskingService(),
    } as ConstructorParameters<typeof Orchestrator>[0]);

    const app = express();
    app.use(express.json());
    app.use(
      createApiChatRouter({
        channelId: '@omadia/channel-api',
        apiKeys,
        auditLog,
        rateLimiter,
        core: {
          handleTurnStream(turn: IncomingTurn) {
            return orchestrator.chatStream({
              userMessage: turn.text,
              sessionScope: turn.conversationId,
            });
          },
        },
      }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('masks PII on the wire to the LLM, and the streamed done event carries a privacy receipt', async () => {
    const created = await apiKeys.create({ label: 'privacy-check' });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({
        message: `Bitte schreibe an ${RAW_EMAIL} wegen des Vertrags.`,
        conversationId: 'privacy-conv-1',
      }),
    });
    assert.equal(res.status, 200);
    const events = parseNdjson(await res.text());

    // (1) The masking actually ran BEFORE the request left the process: the
    // fake LLM provider never saw the raw email on the wire.
    assert.equal(mainRequests.length, 1);
    assert.ok(
      !mainRequests[0]!.includes(RAW_EMAIL),
      'the LLM request must not contain the raw email — masking must have run',
    );
    const surrogate = EMAIL_RE.exec(mainRequests[0]!)?.[0];
    assert.ok(surrogate, 'the LLM request must carry a masked email-shaped surrogate instead');
    assert.notEqual(surrogate, RAW_EMAIL);

    // (2) The `done` event on the PUBLIC API stream carries the aggregate
    // privacy receipt — the same field every other channel's `/chat/stream`
    // exposes (src/routes/chat.ts forwards it unchanged).
    const done = events.find((e) => e['type'] === 'done');
    assert.ok(done, 'stream must end with a done event');
    const receipt = done?.['privacyReceipt'] as
      | { maskedPromptSpans?: Array<{ type: string }> }
      | undefined;
    assert.ok(receipt, 'done event must carry a privacyReceipt — proves masking ran, not just that the plugin loaded');
    assert.ok(
      (receipt.maskedPromptSpans ?? []).some((s) => s.type === 'email'),
      'receipt must record the masked email span',
    );

    // (3) Restore-on-answer: the user-facing answer carries the REAL value
    // back (masking is transport-only, never a lossy transform for the caller).
    assert.ok(
      typeof done?.['answer'] === 'string' && (done['answer'] as string).includes(RAW_EMAIL),
      'the answer streamed back to the API caller must restore the real email',
    );
  });
});
