import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  registerExternalModels,
  type LlmResponse,
  type ModelInfo,
} from '@omadia/llm-provider';

import {
  fromLlmResponse,
  toLlmRequest,
  type AnthropicParams,
} from '../packages/harness-orchestrator/src/llmProviderSeam.js';

// The seam is the inverse of the Anthropic adapter: the orchestrator loop keeps
// building Anthropic-shaped params + reading Anthropic-shaped responses, and the
// seam translates at the provider boundary. These tests pin the translation so
// the round-trip (seam → adapter) stays a behavior-preserving identity.

test('toLlmRequest maps multi-block system with per-block cache breakpoints', () => {
  const params: AnthropicParams = {
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    system: [
      { type: 'text', text: 'prior context', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'date header' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  };
  const req = toLlmRequest(params);
  assert.deepEqual(req.system, [
    { text: 'prior context', cache: true },
    { text: 'stable prompt', cache: true },
    { text: 'date header' },
  ]);
  // string content → single text part
  assert.deepEqual(req.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]);
  assert.equal(req.maxTokens, 4096);
});

test('toLlmRequest maps tools (cache on last → cacheHints.tools) + tool_choice', () => {
  const params: AnthropicParams = {
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      { name: 'a', description: 'A', input_schema: { type: 'object' } },
      {
        name: 'b',
        description: 'B',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  };
  const req = toLlmRequest(params);
  assert.deepEqual(req.tools, [
    { name: 'a', description: 'A', inputSchema: { type: 'object' } },
    { name: 'b', description: 'B', inputSchema: { type: 'object' } },
  ]);
  assert.deepEqual(req.cacheHints, { tools: true });
  // anthropic `any` → neutral `required`
  assert.deepEqual(req.toolChoice, { type: 'required', disableParallel: true });
});

test('toLlmRequest preserves server tools (memory) via serverType, not custom', () => {
  // Regression: the orchestrator's first tool is the Anthropic memory tool
  // `{ type: 'memory_20250818', name: 'memory' }` — a server tool with NO
  // input_schema. Dropping `type` rebuilt it as a custom tool with a missing
  // input_schema → 400 `tools.0.custom.input_schema: Field required`.
  const params: AnthropicParams = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      { type: 'memory_20250818', name: 'memory' },
      { name: 'a', description: 'A', input_schema: { type: 'object' } },
    ],
  };
  const req = toLlmRequest(params);
  assert.deepEqual(req.tools, [
    {
      name: 'memory',
      description: '',
      inputSchema: {},
      serverType: 'memory_20250818',
    },
    { name: 'a', description: 'A', inputSchema: { type: 'object' } },
  ]);
});

test('toLlmRequest maps tool_use echo + tool_result + image blocks', () => {
  const params: AnthropicParams = {
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'BASE64' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'result text',
            is_error: false,
          },
        ],
      },
    ],
  };
  const req = toLlmRequest(params);
  assert.deepEqual(req.messages[0]?.content, [
    { type: 'text', text: 'look at this' },
    { type: 'image', mediaType: 'image/png', data: 'BASE64' },
  ]);
  assert.deepEqual(req.messages[1]?.content, [
    { type: 'tool_call', id: 'tu_1', name: 'lookup', input: { q: 'x' } },
  ]);
  assert.deepEqual(req.messages[2]?.content, [
    {
      type: 'tool_result',
      toolCallId: 'tu_1',
      content: 'result text',
      isError: false,
    },
  ]);
});

test('toLlmRequest threads betas; tool_choice variants', () => {
  const base: AnthropicParams = {
    model: 'm',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'x' }],
  };
  assert.deepEqual(
    toLlmRequest({ ...base, tool_choice: { type: 'auto' } }).toolChoice,
    { type: 'auto' },
  );
  assert.deepEqual(
    toLlmRequest({ ...base, tool_choice: { type: 'tool', name: 't' } }).toolChoice,
    { type: 'tool', name: 't' },
  );
  assert.deepEqual(
    toLlmRequest({ ...base, tool_choice: { type: 'none' } }).toolChoice,
    { type: 'none' },
  );
  assert.deepEqual(toLlmRequest(base, ['context-management-2025-06-27']).betas, [
    'context-management-2025-06-27',
  ]);
  // no betas → field omitted
  assert.equal(toLlmRequest(base).betas, undefined);
  // plain string system passes through
  assert.equal(toLlmRequest({ ...base, system: 'sys' }).system, 'sys');
});

test('fromLlmResponse maps content + stop_reason + snake_case usage', () => {
  const response: LlmResponse = {
    content: [
      { type: 'text', text: 'answer' },
      { type: 'tool_call', id: 'tu_2', name: 'fetch', input: { id: 7 } },
    ],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'claude-opus-4-8',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 50,
      cacheReadTokens: 10,
    },
  };
  assert.deepEqual(fromLlmResponse(response), {
    content: [
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tu_2', name: 'fetch', input: { id: 7 } },
    ],
    stop_reason: 'tool_use',
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 10,
    },
  });
});

test('fromLlmResponse derives stop_reason from finishReason when no provider value', () => {
  const base = {
    content: [{ type: 'text' as const, text: 'x' }],
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  assert.equal(
    fromLlmResponse({ ...base, finishReason: 'stop' }).stop_reason,
    'end_turn',
  );
  assert.equal(
    fromLlmResponse({ ...base, finishReason: 'max_tokens' }).stop_reason,
    'max_tokens',
  );
  assert.equal(
    fromLlmResponse({ ...base, finishReason: 'tool_calls' }).stop_reason,
    'tool_use',
  );
  // usage with no cache fields → snake_case fields omitted
  const usage = fromLlmResponse({ ...base, finishReason: 'stop' }).usage;
  assert.equal(usage.cache_creation_input_tokens, undefined);
  assert.equal(usage.cache_read_input_tokens, undefined);
});

test('fromLlmResponse normalises FOREIGN provider finish reasons (OpenAI) instead of passing them through', () => {
  const base = {
    content: [{ type: 'text' as const, text: 'x' }],
    model: 'gpt-5.5',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  // Regression: OpenAI's raw `finish_reason` is a foreign vocabulary. Passing
  // `tool_calls` straight through made the orchestrator's `stop_reason ===
  // 'tool_use'` dispatch never fire → every OpenAI tool call silently dropped
  // (empty answer). It MUST normalise to Anthropic `tool_use`.
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_calls',
    }).stop_reason,
    'tool_use',
  );
  // Legacy `function_call` (still emitted by the OpenAI adapter) → `tool_use`.
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'tool_calls',
      providerFinishReason: 'function_call',
    }).stop_reason,
    'tool_use',
  );
  // OpenAI `length` → `max_tokens`; `stop`/`content_filter` → `end_turn`.
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'max_tokens',
      providerFinishReason: 'length',
    }).stop_reason,
    'max_tokens',
  );
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'stop',
      providerFinishReason: 'stop',
    }).stop_reason,
    'end_turn',
  );
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'stop',
      providerFinishReason: 'content_filter',
    }).stop_reason,
    'end_turn',
  );
  // The critical path: the OpenAI adapter forces finishReason='tool_calls' when
  // tool calls are present even if the server labelled the raw finish 'stop'.
  // The benign Anthropic-looking raw 'stop' is NOT in the allow-set, so the
  // neutral enum wins → 'tool_use'. A regression here would drop a real tool
  // call carrying a 'stop' finish reason.
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'tool_calls',
      providerFinishReason: 'stop',
    }).stop_reason,
    'tool_use',
  );
});

test('fromLlmResponse preserves native Anthropic stop reasons verbatim (allow-set passthrough)', () => {
  const base = {
    content: [{ type: 'text' as const, text: 'x' }],
    model: 'claude-opus-4-8',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  // Anthropic's own vocabulary round-trips unchanged — `stop_sequence` stays
  // distinct from a plain `end_turn`, and `pause_turn` is not flattened.
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'stop',
      providerFinishReason: 'stop_sequence',
    }).stop_reason,
    'stop_sequence',
  );
  assert.equal(
    fromLlmResponse({
      ...base,
      finishReason: 'stop',
      providerFinishReason: 'pause_turn',
    }).stop_reason,
    'pause_turn',
  );
});

// ---------------------------------------------------------------------------
// #1210 — per-model `max_tokens` clamp
// ---------------------------------------------------------------------------

const OPUS: ModelInfo = {
  id: 'anthropic:claude-opus-5-5',
  provider: 'anthropic',
  modelId: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  class: 'frontier',
  maxTokens: 32_000,
  contextWindow: 200_000,
  vision: true,
  classDefault: true,
};
const HAIKU: ModelInfo = {
  id: 'anthropic:claude-haiku-4-5-20251001',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  label: 'Claude Haiku 4.5',
  class: 'fast',
  maxTokens: 8_192,
  contextWindow: 200_000,
  vision: false,
};

// Same BARE vendor id served by two connected providers with different caps —
// the shape that makes a provider hint necessary rather than cosmetic.
const SHARED_ANTHROPIC: ModelInfo = {
  id: 'anthropic:shared-model-1',
  provider: 'anthropic',
  modelId: 'shared-model-1',
  label: 'Shared (Anthropic)',
  class: 'balanced',
  maxTokens: 30_000,
  contextWindow: 200_000,
  vision: false,
};
const SHARED_COMPAT: ModelInfo = {
  id: 'openai-compatible:shared-model-1',
  provider: 'openai-compatible',
  modelId: 'shared-model-1',
  label: 'Shared (self-hosted)',
  class: 'balanced',
  maxTokens: 4_096,
  contextWindow: 32_000,
  vision: false,
};

function params(model: string, maxTokens: number): AnthropicParams {
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'hi' }],
  };
}

// The orchestrator's budget is floored at the frontier class's ceiling, so a
// model with a smaller cap receives a value its API rejects outright (400 on
// the whole request, not a silent cap) — every turn on that model would fail.
test('toLlmRequest clamps max_tokens to a smaller model\'s own ceiling', () => {
  const dispose = registerExternalModels([OPUS, HAIKU]);
  try {
    assert.equal(toLlmRequest(params(HAIKU.modelId, 32_000)).maxTokens, 8_192);
    // Provider-qualified and alias forms resolve to the same ceiling.
    assert.equal(toLlmRequest(params(HAIKU.id, 32_000)).maxTokens, 8_192);
  } finally {
    dispose();
  }
});

test('toLlmRequest leaves a budget the model can serve untouched', () => {
  const dispose = registerExternalModels([OPUS, HAIKU]);
  try {
    assert.equal(toLlmRequest(params(OPUS.modelId, 32_000)).maxTokens, 32_000);
    // A router/screener asking for a tiny budget is never raised to the cap.
    assert.equal(toLlmRequest(params(OPUS.modelId, 8)).maxTokens, 8);
    assert.equal(toLlmRequest(params(HAIKU.modelId, 1_024)).maxTokens, 1_024);
  } finally {
    dispose();
  }
});

// The registry is a curated overlay, not the universe of valid ids: an
// operator-typed id (a local Ollama build, a fine-tune) must keep reaching the
// vendor with the budget the caller asked for, exactly as before the clamp.
test('toLlmRequest passes an unregistered model id through unclamped', () => {
  const dispose = registerExternalModels([OPUS, HAIKU]);
  try {
    assert.equal(
      toLlmRequest(params('my-local-llama-70b', 32_000)).maxTokens,
      32_000,
    );
  } finally {
    dispose();
  }
});

test('toLlmRequest needs no registry at all (empty overlay = no clamp)', () => {
  assert.equal(toLlmRequest(params('claude-haiku-4-5-20251001', 32_000)).maxTokens, 32_000);
});

// Without a hint a bare id two providers serve is ambiguous, so the budget must
// pass through rather than be clamped to whichever owner happens to answer.
// With the hint it clamps to the connection the request is actually going to.
test('toLlmRequest resolves the ceiling on the named provider, not the default one', () => {
  const dispose = registerExternalModels([SHARED_ANTHROPIC, SHARED_COMPAT]);
  try {
    assert.equal(toLlmRequest(params('shared-model-1', 32_000)).maxTokens, 32_000);
    assert.equal(
      toLlmRequest(params('shared-model-1', 32_000), undefined, 'openai-compatible')
        .maxTokens,
      4_096,
    );
    assert.equal(
      toLlmRequest(params('shared-model-1', 32_000), undefined, 'anthropic').maxTokens,
      30_000,
    );
  } finally {
    dispose();
  }
});

// A class ref should never reach the provider — the plugin resolves refs to a
// concrete id at build time. If one does, an unhinted lookup would silently
// answer with ANTHROPIC's model for that class, i.e. an Anthropic ceiling on
// someone else's turn. Unhinted: leave it alone. Hinted: the hint decides.
test('toLlmRequest does not clamp a class ref without a provider hint', () => {
  const dispose = registerExternalModels([OPUS, HAIKU, SHARED_COMPAT]);
  try {
    assert.equal(toLlmRequest(params('class:frontier', 32_000)).maxTokens, 32_000);
    assert.equal(
      toLlmRequest(params('class:balanced', 32_000), undefined, 'openai-compatible')
        .maxTokens,
      4_096,
    );
  } finally {
    dispose();
  }
});
