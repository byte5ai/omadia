/**
 * #1033 W3 — the fallback through the WHOLE orchestrator: a policy names a
 * fallback on another provider; the primary is rate-limited; the answer comes
 * from the fallback, the receipt names the model + provider that actually
 * answered with `fallbackUsed: true`, the streaming UI gets a
 * `provider_fallback` chip, and — because the fallback is another model
 * family — the system prompt is the one compiled for THAT family.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { createProviderHealth } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import type { TurnReceiptRecordInput } from '@omadia/plugin-api';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function answer(text: string, model: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** Records every request so the test can read the system prompt it was sent. */
function answering(id: string, text: string, seen: LlmRequest[]): LlmProvider {
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest) => {
      seen.push(req);
      return answer(text, req.model);
    },
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        seen.push(req);
        yield { type: 'text_delta', text } as LlmStreamEvent;
        yield { type: 'final', response: answer(text, req.model) } as LlmStreamEvent;
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function rateLimited(id: string): LlmProvider {
  const err = Object.assign(new Error(`${id}: 429 rate_limit_error`), { status: 429 });
  return {
    id,
    capabilities: CAPS,
    complete: async () => {
      throw err;
    },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        throw err;
      },
    }),
    classifyError: () => ({ retryable: true, kind: 'rate_limit' as const }),
  } as unknown as LlmProvider;
}

function systemText(req: LlmRequest): string {
  const s = req.system;
  if (s === undefined) return '';
  return typeof s === 'string' ? s : s.map((b) => b.text).join('\n');
}

function harness(opts: { primaryFails: boolean }) {
  const seen: LlmRequest[] = [];
  const receipts: TurnReceiptRecordInput[] = [];
  const backup = answering('openai', 'from backup', seen);
  const primary = opts.primaryFails ? rateLimited('anthropic') : answering('anthropic', 'from primary', seen);
  const health = createProviderHealth({ now: () => 1_000 });
  const pool = {
    get: async (id: string) => (id === 'openai' ? backup : id === 'anthropic' ? primary : undefined),
    health,
  };
  const orchestrator = new Orchestrator({
    provider: primary,
    model: 'claude-opus-4-8',
    maxTokens: 64,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'fb-agent',
    providerPool: pool,
    fallbackRef: { provider: 'openai', model: 'gpt-5.5', effort: 'medium' },
    // The primary family (opus) is the default composed prompt; the fallback
    // model is unknown to the family inference → 'sonnet' — the map carries
    // a prompt for exactly that family.
    assistantIdentity: 'OPUS-PROMPT',
    identityByFamily: { opus: 'OPUS-PROMPT', sonnet: 'SONNET-PROMPT' },
    turnReceiptStore: () => ({
      record: async (entry: TurnReceiptRecordInput) => {
        receipts.push(entry);
      },
    }),
  } as never);
  return { orchestrator, seen, receipts, health };
}

describe('provider fallback through the orchestrator (#1033 W3)', () => {
  it('buffered: answers from the fallback with its family prompt and effort; the trace records it', async () => {
    const h = harness({ primaryFails: true });
    const result = await h.orchestrator.runTurn({ userMessage: 'hallo', sessionScope: 's-1' });
    assert.equal(result.answer, 'from backup');
    const req = h.seen.at(-1)!;
    assert.equal(req.model, 'gpt-5.5');
    assert.equal(req.effort, 'medium');
    assert.match(systemText(req), /SONNET-PROMPT/);
    assert.doesNotMatch(systemText(req), /OPUS-PROMPT/);
    assert.equal(h.health.inCooldown('anthropic'), true);
  });

  it('streamed: emits a provider_fallback routing event and answers from the fallback', async () => {
    const h = harness({ primaryFails: true });
    const events: Array<{ type: string; reason?: string; provider?: string; model?: string }> = [];
    let text = '';
    for await (const ev of h.orchestrator.chatStream({ userMessage: 'hallo', sessionScope: 's-2' })) {
      events.push(ev as never);
      if (ev.type === 'text_delta') text += ev.text;
    }
    assert.equal(text, 'from backup');
    const routing = events.find((e) => e.type === 'turn_routing');
    assert.ok(routing, 'a turn_routing event marks the hop');
    assert.equal(routing?.reason, 'provider_fallback');
    assert.equal(routing?.provider, 'openai');
    assert.equal(routing?.model, 'gpt-5.5');
  });

  it('a healthy primary answers itself — no hop, no chip, primary prompt', async () => {
    const h = harness({ primaryFails: false });
    const result = await h.orchestrator.runTurn({ userMessage: 'hallo', sessionScope: 's-3' });
    assert.equal(result.answer, 'from primary');
    assert.equal(h.seen.at(-1)!.model, 'claude-opus-4-8');
    assert.match(systemText(h.seen.at(-1)!), /OPUS-PROMPT/);
    assert.equal(h.health.inCooldown('anthropic'), false);
  });
});

// ── advisor round: no cross-provider hop once the tool loop has a transcript ──

/**
 * A provider whose PRIMARY model follows a call script while another model
 * on the same wire answers at once — the shape of a same-provider fallback,
 * which reuses the primary's client and only changes the model id.
 */
function scripted(
  id: string,
  calls: Array<LlmStreamEvent[] | Error>,
  byModel: Record<string, LlmStreamEvent[]> = {},
): LlmProvider {
  let idx = 0;
  const next = (req: LlmRequest): LlmStreamEvent[] => {
    const fixed = byModel[req.model];
    if (fixed) return fixed;
    const c = calls[idx];
    idx += 1;
    if (c === undefined) throw new Error(`no scripted call ${String(idx)} for ${id}`);
    if (c instanceof Error) throw c;
    return c;
  };
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      const events = next(req);
      return (events.at(-1) as { response: LlmResponse }).response;
    },
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        for (const ev of next(req)) yield ev;
      },
    }),
    classifyError: () => ({ retryable: true, kind: 'rate_limit' as const }),
  } as unknown as LlmProvider;
}

function toolCall(): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [
          { type: 'tool_call', id: 'tu-1', name: 'memory', input: { command: 'view', path: '/memories' } },
        ],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    } as LlmStreamEvent,
  ];
}

function finalText(text: string, model: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text } as LlmStreamEvent,
    { type: 'final', response: answer(text, model) } as LlmStreamEvent,
  ];
}

describe('fallback scope across the tool loop (#1033 W3, advisor round)', () => {
  const rateLimited = Object.assign(new Error('429 rate_limit_error'), { status: 429 });

  function build(fallback: { provider: string; model: string }, seen: LlmRequest[]) {
    // Iteration 0: a tool call (memory view); iteration 1: the primary MODEL
    // dies — while the same provider still answers for its sibling model
    // (that is what a same-provider fallback is: same client, other model).
    const primary = scripted('anthropic', [toolCall(), rateLimited], {
      'claude-sonnet-4-6': finalText('from same-wire fallback', 'claude-sonnet-4-6'),
    });
    const otherWire = answering('openai', 'from other-wire fallback', seen);
    const pool = {
      get: async (id: string) => (id === 'openai' ? otherWire : id === 'anthropic' ? primary : undefined),
      health: createProviderHealth({ now: () => 1_000 }),
    };
    const root = new InMemoryMemoryStore();
    return new Orchestrator({
      provider: primary,
      model: 'claude-opus-4-8',
      maxTokens: 64,
      maxToolIterations: 4,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      agentId: 'fb-scope',
      memoryToolHandler: new MemoryToolHandler(root),
      providerPool: pool,
      fallbackRef: fallback,
    } as never);
  }

  it('a CROSS-provider fallback is not taken after iteration 0 — the error propagates', async () => {
    const seen: LlmRequest[] = [];
    const orchestrator = build({ provider: 'openai', model: 'gpt-5.5' }, seen);
    await assert.rejects(
      orchestrator.runTurn({ userMessage: 'hallo', sessionScope: 's-x' }),
      /rate_limit_error/,
    );
    assert.equal(seen.length, 0, 'the other-wire provider never saw the transcript');
  });

  it('a SAME-provider fallback (another model on the same wire) may hop mid-loop', async () => {
    const seen: LlmRequest[] = [];
    const orchestrator = build({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, seen);
    const result = await orchestrator.runTurn({ userMessage: 'hallo', sessionScope: 's-y' });
    assert.equal(result.answer, 'from same-wire fallback');
  });
});
