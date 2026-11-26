/**
 * ADR-0017 — a plugin's `ctx.llm` call inside a guarded turn is masked
 * before it leaves and restored before the plugin reads the answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrivacyTurnHandle } from '@omadia/orchestrator';
import type { LlmCompleteResult } from '@omadia/plugin-api';

import { LlmPrivacyBlockedError, shieldPluginLlmCall } from '../src/platform/pluginLlmPrivacy.js';

const REAL = 'Erika Mustermann';
const SURROGATE = 'PERSON-1';

function handle(opts: { blocked?: boolean; maskingOff?: boolean } = {}): PrivacyTurnHandle {
  return {
    remaskPromptValues: (text: string) => text.replaceAll(REAL, SURROGATE),
    maskUserPrompt: async (text: string) => {
      if (opts.blocked) return { outcome: 'blocked', reason: 'detector unavailable' };
      if (opts.maskingOff) return { outcome: 'disabled' };
      return {
        outcome: 'masked',
        maskedText: text.replaceAll('erika@example.com', 'EMAIL-1'),
        spans: [],
        degraded: false,
      };
    },
    restorePromptPseudonyms: async (text: string) =>
      text.replaceAll(SURROGATE, REAL).replaceAll('EMAIL-1', 'erika@example.com'),
  } as unknown as PrivacyTurnHandle;
}

const answer = (text: string, extra: Partial<LlmCompleteResult> = {}): LlmCompleteResult => ({
  text,
  model: 'm',
  inputTokens: 1,
  outputTokens: 1,
  finishReason: 'stop',
  stopReason: 'end_turn',
  ...extra,
});

test('no privacy handle: request and answer pass byte-identical', async () => {
  const request = { model: 'm', system: REAL, messages: [{ role: 'user' as const, content: REAL }] };
  const shielded = await shieldPluginLlmCall(undefined, 'p', request);
  assert.equal(shielded.request, request);
  const result = answer(REAL);
  assert.equal(await shielded.restore(result), result);
});

test('guarded turn: system and messages are masked, answer and tool inputs restored', async () => {
  const shielded = await shieldPluginLlmCall(handle(), 'p', {
    model: 'm',
    system: `Kunde ${REAL}`,
    messages: [{ role: 'user', content: `Mail an erika@example.com für ${REAL}` }],
  });
  assert.equal(shielded.request.system, `Kunde ${SURROGATE}`);
  assert.equal(shielded.request.messages[0]?.content, `Mail an EMAIL-1 für ${SURROGATE}`);

  const restored = await shielded.restore(
    answer(`Hallo ${SURROGATE}`, {
      finishReason: 'tool_calls',
      toolCalls: [{ name: 'send', input: { to: 'EMAIL-1', names: [SURROGATE], n: 2 } }],
    }),
  );
  assert.equal(restored.text, `Hallo ${REAL}`);
  assert.deepEqual(restored.toolCalls?.[0]?.input, { to: 'erika@example.com', names: [REAL], n: 2 });
});

test('prompt masking off: turn values are still re-masked', async () => {
  const shielded = await shieldPluginLlmCall(handle({ maskingOff: true }), 'p', {
    model: 'm',
    messages: [{ role: 'user', content: `Für ${REAL}` }],
  });
  assert.equal(shielded.request.messages[0]?.content, `Für ${SURROGATE}`);
});

test('blocked mask fails the call closed', async () => {
  await assert.rejects(
    shieldPluginLlmCall(handle({ blocked: true }), 'p', {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    }),
    LlmPrivacyBlockedError,
  );
});
