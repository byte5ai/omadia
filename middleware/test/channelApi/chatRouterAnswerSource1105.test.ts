/**
 * Issue #1105 regression: the public API NDJSON stream must not present two
 * contradicting readings of the same turn. When Privacy Shield v4 renders the
 * final answer server-side, the streamed `text_delta` chunks (the model's own
 * text) and `done.answer` (the server render) diverge. The fix does NOT force
 * them to agree — a server render is authoritative by design — it makes the
 * divergence explicit: the `done` event carries `answerSource: 'privacy-render'`
 * so a streaming client knows the accumulated deltas are stale and must render
 * `done.answer` instead.
 *
 * This drives the REAL orchestrator streaming path through the REAL
 * `createApiChatRouter` seam (same wiring as `chatRouterPrivacyIntegration`),
 * with a privacy-guard service whose `takeRenderedAnswerV4` yields a
 * server-rendered answer — the exact condition under which
 * `Orchestrator.chatStream` swaps the answer in just before `done`.
 */

import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

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

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-api-key-auth/src/rateLimiter.js';
import { createApiChatRouter } from '../../packages/harness-channel-api/src/chatRouter.js';
import { createInProcessClient, type InProcessClient } from '../support/inProcessHttp.js';
import { createFakeSecrets } from './testSecrets.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** The model's own streamed text — what `text_delta` carries. */
const MODEL_PREVIEW = 'Die Routine ist angelegt.';
/** The server-materialized answer — what `done.answer` must carry on a render turn. */
const SERVER_RENDERED = 'Error: routines are unavailable in this session.';

function finalResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Streams the model's own preview text, then finishes. No tools. */
function previewStreamProvider(): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: (): Promise<LlmResponse> => {
      throw new Error('previewStreamProvider: complete() not scripted — chatStream uses stream()');
    },
    stream: async function* (_req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      yield { type: 'text_delta', text: MODEL_PREVIEW };
      yield { type: 'final', response: finalResponse(MODEL_PREVIEW) };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/**
 * The real privacy-guard service, but with `takeRenderedAnswerV4` overridden to
 * yield a server render — the exact hook `Orchestrator.chatStream` drains right
 * before `done`. `renderText: undefined` leaves the real behaviour (no render),
 * the control for "no `answerSource` on an ordinary turn".
 */
function serviceWith(renderText: string | undefined): ReturnType<typeof createPrivacyGuardService> {
  const real = createPrivacyGuardService();
  if (renderText === undefined) return real;
  return {
    ...real,
    async takeRenderedAnswerV4() {
      return { text: renderText, maskedValues: [] as readonly string[] };
    },
  };
}

function parseNdjson(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function buildClient(renderText: string | undefined): {
  client: InProcessClient;
  apiKeys: ReturnType<typeof createApiKeyStore>;
} {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const auditLog = createAuditLog(secrets);
  const rateLimiter = createRateLimiter();

  const orchestrator = new Orchestrator({
    provider: previewStreamProvider(),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    privacyGuard: () => serviceWith(renderText),
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
  return { client: createInProcessClient(app), apiKeys };
}

async function runTurn(
  client: InProcessClient,
  apiKeys: ReturnType<typeof createApiKeyStore>,
): Promise<{ events: Array<Record<string, unknown>>; deltas: string; done: Record<string, unknown> }> {
  const created = await apiKeys.create({ label: '1105' });
  const res = await client.fetch('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
    body: JSON.stringify({ message: 'Lege eine Routine an.', conversationId: 'conv-1105' }),
  });
  assert.equal(res.status, 200);
  const events = parseNdjson(await res.text());
  const deltas = events
    .filter((e) => e['type'] === 'text_delta')
    .map((e) => String(e['text'] ?? ''))
    .join('');
  const done = events.find((e) => e['type'] === 'done');
  assert.ok(done, 'stream must end with a done event');
  return { events, deltas, done };
}

describe('channelApi/chatRouter — #1105 answerSource on a server-rendered turn', () => {
  it('marks the done event `privacy-render` and makes the delta/done divergence explicit', async () => {
    const { client, apiKeys } = buildClient(SERVER_RENDERED);
    const { deltas, done } = await runTurn(client, apiKeys);

    // The two documented readings genuinely diverge on a render turn …
    // (`done.answer` may carry an appended AI-Act disclosure line, so match on
    // substring, not equality.)
    assert.equal(deltas, MODEL_PREVIEW, 'text_delta carried the model preview');
    assert.ok(
      String(done['answer']).includes(SERVER_RENDERED),
      'done.answer carried the server render',
    );
    assert.ok(
      !String(done['answer']).includes(MODEL_PREVIEW),
      'the server render replaced the model preview — the readings diverge',
    );

    // … and the fix signals it, so a streaming client knows done.answer wins.
    assert.equal(
      done['answerSource'],
      'privacy-render',
      'done must flag the server render so the stale deltas are not treated as the answer',
    );
  });

  it('leaves answerSource unset on an ordinary turn (deltas ARE the answer)', async () => {
    const { client, apiKeys } = buildClient(undefined);
    const { deltas, done } = await runTurn(client, apiKeys);

    // `done.answer` may carry an appended AI-Act disclosure line; the model's
    // streamed text is its prefix, so the deltas still reconstruct the answer.
    assert.equal(deltas, MODEL_PREVIEW, 'text_delta carried the model text');
    assert.ok(
      String(done['answer']).includes(MODEL_PREVIEW),
      'no server render — done.answer is built from the streamed model text',
    );
    assert.equal(
      done['answerSource'],
      undefined,
      'the ordinary case omits answerSource (an omitted field means "model")',
    );
  });
});
