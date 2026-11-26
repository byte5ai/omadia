/**
 * #1992 / ADR-0220 — the answer language follows the user; the operator's
 * `answer_language` is only the fallback. Orchestrator code from SOURCE.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  ANSWER_LANGUAGES,
  buildAnswerLanguageRule,
  parseAnswerLanguage,
  type AnswerLanguage,
} from '../packages/harness-orchestrator/src/answerLanguage.js';
import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Flatten `LlmRequest.system` (string or blocks) to one string. */
function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (sys === undefined) return '';
  if (typeof sys === 'string') return sys;
  return sys
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** A provider that answers with fixed text and records every system prompt. */
function capturingProvider(captured: string[]): LlmProvider {
  const response: LlmResponse = {
    content: [{ type: 'text', text: 'Antwort.' }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      captured.push(systemText(req));
      return response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        captured.push(systemText(req));
        yield { type: 'text_delta', text: 'Antwort.' };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

async function systemPromptFor(answerLanguage: AnswerLanguage | undefined): Promise<string> {
  const captured: string[] = [];
  const deps: OrchestratorDeps = {
    provider: capturingProvider(captured),
    knowledgeGraph: undefined as unknown as KnowledgeGraph,
    memoryStore: undefined as unknown as MemoryStore,
    entityRefBus: undefined as unknown as EntityRefBus,
    nativeToolRegistry: new NativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    ...(answerLanguage ? { answerLanguage } : {}),
  };
  const built = buildOrchestratorForAgent(
    { agentId: 'solo', model: 'test', maxTokens: 1024, maxToolIterations: 3 },
    deps,
  );
  await built.orchestrator.chat({ userMessage: 'How many open invoices are there?' });
  const first = captured[0];
  assert.ok(first !== undefined, 'provider never received a request');
  return first;
}

describe('answer language (#1992, ADR-0220)', () => {
  it('parses every enum value case-insensitively, unknown → undefined', () => {
    for (const lang of ANSWER_LANGUAGES) {
      assert.equal(parseAnswerLanguage(` ${lang.toUpperCase()} `), lang);
    }
    assert.equal(parseAnswerLanguage('klingon'), undefined);
    assert.equal(parseAnswerLanguage(undefined), undefined);
  });

  it('the prompt mirrors the user and no longer hard-codes German', async () => {
    const prompt = await systemPromptFor(undefined);
    assert.ok(prompt.includes(buildAnswerLanguageRule('de')));
    assert.doesNotMatch(prompt, /Antworte immer auf Deutsch/);
    assert.match(prompt, /Sprache, in der der Nutzer seine letzte Nachricht geschrieben hat/);
  });

  it('the operator fallback reaches the prompt through the real wiring', async () => {
    const prompt = await systemPromptFor('en');
    assert.match(prompt, /ohne Gespräch auf Englisch\./);
    assert.doesNotMatch(prompt, /ohne Gespräch auf Deutsch/);
  });
});
