/**
 * `ctx.llm` forced tool use (plugin-api 1.44.0) — a plugin can force ONE
 * tool call with an input schema and gets the tool input back as parsed
 * JSON (`toolCalls`). The router/planner of `@omadia/fast-path` rely on it:
 * a forced tool call has no prose path, unlike a "JSON only" prompt.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { createAnthropicLlmProvider } from '../src/platform/anthropicLlmProvider.js';

function client(captured: { params?: Record<string, unknown> }, response: Record<string, unknown>): Anthropic {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        captured.params = params;
        return response;
      },
    },
  } as unknown as Anthropic;
}

const toolUseResponse = {
  id: 'msg_t',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'route_turn', input: { decision: 'agent_simple', confidence: 0.9 } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 50, output_tokens: 12 },
};

const ROUTE_TOOL = {
  name: 'route_turn',
  description: 'Classify the turn.',
  inputSchema: {
    type: 'object',
    properties: { decision: { type: 'string' }, confidence: { type: 'number' } },
    required: ['decision', 'confidence'],
  },
};

test('forced tool: tools + tool_choice {type:tool,name} reach the wire, no output_config schema', async () => {
  const captured: { params?: Record<string, unknown> } = {};
  const provider = createAnthropicLlmProvider({ client: client(captured, toolUseResponse), log: () => {} });
  const res = await provider.complete({
    model: 'claude-haiku-5-5',
    messages: [{ role: 'user', content: 'Hallo' }],
    maxTokens: 200,
    effort: 'low',
    thinking: 'off',
    tools: [ROUTE_TOOL],
    toolChoice: { name: 'route_turn' },
  });
  const p = captured.params ?? {};
  assert.deepEqual(p['tool_choice'], { type: 'tool', name: 'route_turn', disable_parallel_tool_use: true });
  const tools = p['tools'] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.['name'], 'route_turn');
  assert.deepEqual(tools[0]?.['input_schema'], ROUTE_TOOL.inputSchema);
  // thinking is disabled — Anthropic rejects a forced tool with thinking on
  assert.deepEqual(p['thinking'], { type: 'disabled' });
  const outputConfig = p['output_config'] as Record<string, unknown> | undefined;
  assert.equal(outputConfig?.['format'], undefined);
  // the tool input comes back parsed; there is no prose
  assert.deepEqual(res.toolCalls, [{ name: 'route_turn', input: { decision: 'agent_simple', confidence: 0.9 } }]);
  assert.equal(res.text, '');
  assert.equal(res.finishReason, 'tool_calls');
});

test('without tools the request and result keep the v1 shape (no toolCalls key)', async () => {
  const captured: { params?: Record<string, unknown> } = {};
  const provider = createAnthropicLlmProvider({
    client: client(captured, {
      ...toolUseResponse,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }),
    log: () => {},
  });
  const res = await provider.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal('tools' in (captured.params ?? {}), false);
  assert.equal('tool_choice' in (captured.params ?? {}), false);
  assert.equal('toolCalls' in res, false);
  assert.equal(res.text, 'ok');
});
