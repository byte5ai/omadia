/**
 * #1033 W3 — the provider fallback at the stream layer.
 *
 * One hop, only before any output reached the client, only on availability
 * failures; the primary's breaker trips so the next turn skips straight to
 * the fallback; the buffered `complete()` path mirrors it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { createProviderHealth } from '@omadia/llm-provider';

import {
  completeWithFallback,
  fallbackReasonFor,
  streamMessageEvents,
  type StreamMessageEvent,
} from '../packages/harness-orchestrator/src/streaming.js';

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function response(text: string, model: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function answering(id: string, text: string): LlmProvider {
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest) => response(text, req.model),
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text } as LlmStreamEvent;
        yield { type: 'final', response: response(text, req.model) } as LlmStreamEvent;
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function failing(id: string, kind: 'rate_limit' | 'auth' | 'other', opts: { afterText?: boolean } = {}): LlmProvider {
  const err = Object.assign(new Error(`${id} ${kind}`), { status: kind === 'auth' ? 401 : 429 });
  return {
    id,
    capabilities: CAPS,
    complete: async () => {
      throw err;
    },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        if (opts.afterText) yield { type: 'text_delta', text: 'partial' } as LlmStreamEvent;
        throw err;
      },
    }),
    classifyError: () => ({ retryable: kind === 'rate_limit', kind }),
  } as unknown as LlmProvider;
}

async function collect(gen: AsyncGenerator<StreamMessageEvent>): Promise<StreamMessageEvent[]> {
  const out: StreamMessageEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const PARAMS = { model: 'primary-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
const FB_PARAMS = { ...PARAMS, model: 'fallback-model' };

describe('fallbackReasonFor', () => {
  it('auth immediately; rate_limit/overloaded only once retries are spent; content errors never', () => {
    const p = (kind: 'rate_limit' | 'overloaded' | 'auth' | 'other') => ({
      classifyError: () => ({ retryable: kind !== 'auth', kind }),
    });
    assert.equal(fallbackReasonFor(p('auth'), new Error('x'), 1), 'auth');
    assert.equal(fallbackReasonFor(p('rate_limit'), new Error('x'), 1), undefined);
    assert.equal(fallbackReasonFor(p('rate_limit'), new Error('x'), 5), 'rate_limit');
    assert.equal(fallbackReasonFor(p('overloaded'), new Error('x'), 5), 'overloaded');
    assert.equal(fallbackReasonFor(p('other'), new Error('tool schema invalid'), 5), undefined);
    assert.equal(fallbackReasonFor(p('other'), Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }), 1), 'unreachable');
    assert.equal(fallbackReasonFor(p('other'), Object.assign(new Error('not_found_error: model'), { status: 404 }), 1), 'model_not_found');
  });
});

describe('streamMessageEvents fallback', () => {
  it('hops to the fallback on an auth failure before any output, trips the breaker, and finishes there', async () => {
    const health = createProviderHealth({ now: () => 1_000 });
    const events = await collect(
      streamMessageEvents({
        provider: failing('primary', 'auth'),
        params: PARAMS,
        observer: undefined,
        iteration: 0,
        streamLabel: 'test',
        fallback: { provider: answering('backup', 'from backup'), params: FB_PARAMS, health },
      }),
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ['fallback', 'text_delta', 'final'],
    );
    const hop = events[0] as { type: 'fallback'; providerId: string; model: string; reason: string };
    assert.equal(hop.providerId, 'backup');
    assert.equal(hop.model, 'fallback-model');
    assert.equal(hop.reason, 'auth');
    assert.equal(health.inCooldown('primary'), true);
    assert.equal(health.inCooldown('backup'), false);
  });

  it('does NOT hop once text has been forwarded — the error propagates', async () => {
    await assert.rejects(
      collect(
        streamMessageEvents({
          provider: failing('primary', 'auth', { afterText: true }),
          params: PARAMS,
          observer: undefined,
          iteration: 0,
          streamLabel: 'test',
          fallback: { provider: answering('backup', 'x'), params: FB_PARAMS },
        }),
      ),
      /primary auth/,
    );
  });

  it('does NOT hop on a content error', async () => {
    await assert.rejects(
      collect(
        streamMessageEvents({
          provider: failing('primary', 'other'),
          params: PARAMS,
          observer: undefined,
          iteration: 0,
          streamLabel: 'test',
          fallback: { provider: answering('backup', 'x'), params: FB_PARAMS },
        }),
      ),
      /primary other/,
    );
  });

  it('starts on the fallback while the primary is in cooldown — no retry budget paid', async () => {
    const health = createProviderHealth({ now: () => 1_000 });
    health.markFailed('primary', 'auth');
    let primaryCalls = 0;
    const primary = answering('primary', 'from primary');
    const counting = {
      ...primary,
      stream: (req: never) => {
        primaryCalls += 1;
        return primary.stream(req);
      },
    } as unknown as LlmProvider;
    const events = await collect(
      streamMessageEvents({
        provider: counting,
        params: PARAMS,
        observer: undefined,
        iteration: 0,
        streamLabel: 'test',
        fallback: { provider: answering('backup', 'from backup'), params: FB_PARAMS, health },
      }),
    );
    assert.equal(primaryCalls, 0);
    assert.equal((events[0] as { reason: string }).reason, 'cooldown');
  });

  it('without a fallback the behaviour is unchanged', async () => {
    await assert.rejects(
      collect(
        streamMessageEvents({
          provider: failing('primary', 'auth'),
          params: PARAMS,
          observer: undefined,
          iteration: 0,
          streamLabel: 'test',
        }),
      ),
      /primary auth/,
    );
  });
});

describe('completeWithFallback', () => {
  it('answers on the primary when it works, on the fallback when it does not', async () => {
    const health = createProviderHealth({ now: () => 1_000 });
    const ok = await completeWithFallback({
      provider: answering('primary', 'p'),
      request: { model: 'primary-model', maxTokens: 16, messages: [] },
      fallback: { provider: answering('backup', 'b'), request: { model: 'fallback-model', maxTokens: 16, messages: [] }, health },
      streamLabel: 'test',
    });
    assert.equal(ok.fallbackUsed, undefined);
    assert.equal(ok.response.model, 'primary-model');

    const hopped = await completeWithFallback({
      provider: failing('primary', 'rate_limit'),
      request: { model: 'primary-model', maxTokens: 16, messages: [] },
      fallback: { provider: answering('backup', 'b'), request: { model: 'fallback-model', maxTokens: 16, messages: [] }, health },
      streamLabel: 'test',
    });
    assert.deepEqual(hopped.fallbackUsed, { providerId: 'backup', model: 'fallback-model', reason: 'rate_limit' });
    assert.equal(hopped.response.model, 'fallback-model');
    assert.equal(health.inCooldown('primary'), true);
  });

  it('propagates when there is no fallback or the failure is not an availability one', async () => {
    await assert.rejects(
      completeWithFallback({
        provider: failing('primary', 'auth'),
        request: { model: 'm', maxTokens: 1, messages: [] },
        streamLabel: 'test',
      }),
      /primary auth/,
    );
    await assert.rejects(
      completeWithFallback({
        provider: failing('primary', 'other'),
        request: { model: 'm', maxTokens: 1, messages: [] },
        fallback: { provider: answering('backup', 'b'), request: { model: 'f', maxTokens: 1, messages: [] } },
        streamLabel: 'test',
      }),
      /primary other/,
    );
  });
});

describe('createProviderHealth', () => {
  it('cools down for the window, then probes again', () => {
    let t = 0;
    const health = createProviderHealth({ cooldownMs: 100, now: () => t });
    health.markFailed('p', 'auth');
    assert.equal(health.inCooldown('p'), true);
    assert.equal(health.snapshot()[0]?.reason, 'auth');
    t = 99;
    assert.equal(health.inCooldown('p'), true);
    t = 100;
    assert.equal(health.inCooldown('p'), false);
    assert.deepEqual(health.snapshot(), []);
    health.markFailed('p', 'auth');
    health.markHealthy('p');
    assert.equal(health.inCooldown('p'), false);
  });
});
