/**
 * #1544 — with `mask_user_prompt` on, a tool searched for the placeholder the
 * model saw ("PLATZHALTER-CUSTOM-1") instead of the user's value, so every
 * search for a masked term came back empty.
 *
 * Drives the REAL `Orchestrator` with the REAL privacy-guard service:
 *   - a native tool's handler gets the user's value, while no model request
 *     carries it;
 *   - a domain tool keeps the placeholder: its input is the question for a
 *     sub-agent's own model;
 *   - `remaskPromptValues` turns an echoed value back into its placeholder
 *     (what an interning-exempt tool's result gets before the model reads it).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const TERM = 'Projekt Falkenstein';
const PLACEHOLDER = /PLATZHALTER-CUSTOM-\d+/;
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' ? 'on' : key === 'custom_terms' ? TERM : undefined,
  });
}

function reply(content: unknown[], finishReason: 'tool_calls' | 'stop'): LlmResponse {
  return {
    content,
    finishReason,
    providerFinishReason: finishReason === 'stop' ? 'end_turn' : 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Step 1: call `toolName` with the placeholder it was sent; step 2: stop. */
function searchingProvider(toolName: string, requests: string[]): LlmProvider {
  let step = 0;
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (req: LlmRequest) => {
      const serialized = JSON.stringify(req.messages);
      requests.push(serialized);
      step += 1;
      if (step === 1) {
        const placeholder = PLACEHOLDER.exec(serialized)?.[0];
        assert.ok(placeholder, 'the model was sent a placeholder for the term');
        return Promise.resolve(
          reply(
            [{ type: 'tool_call', id: 'use-1', name: toolName, input: { query: `Stand von ${placeholder}?` } }],
            'tool_calls',
          ),
        );
      }
      return Promise.resolve(reply([{ type: 'text', text: 'Fertig.' }], 'stop'));
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

describe('#1544 — tools run on the user values, models see placeholders', () => {
  it('restores the placeholder in a native tool input, never on the LLM wire', async () => {
    const seen: unknown[] = [];
    const registry = new NativeToolRegistry();
    registry.register('search_docs', {
      handler: (input: unknown) => {
        seen.push(input);
        return Promise.resolve('Error: nothing found');
      },
      spec: {
        name: 'search_docs',
        description: 'Search documents',
        input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: [] },
      } as never,
    });
    const requests: string[] = [];
    const orchestrator = new Orchestrator({
      provider: searchingProvider('search_docs', requests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: registry,
      privacyGuard: () => maskingService(),
    } as ConstructorParameters<typeof Orchestrator>[0]);

    await orchestrator.runTurn({ userMessage: `Was ist der aktuelle Stand von ${TERM}?` });

    assert.deepEqual(seen, [{ query: `Stand von ${TERM}?` }], 'the handler got the user value');
    for (const request of requests) {
      assert.ok(!request.includes('Falkenstein'), 'the user value reached the LLM wire');
    }
  });

  it('hands a domain tool (a sub-agent question) the placeholder', async () => {
    const seen: unknown[] = [];
    const requests: string[] = [];
    const orchestrator = new Orchestrator({
      provider: searchingProvider('query_docs', requests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [
        {
          name: 'query_docs',
          domain: 'docs',
          spec: {
            name: 'query_docs',
            description: 'Ask the docs agent',
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: [] },
          },
          handle: (input: unknown) => {
            seen.push(input);
            return Promise.resolve('Keine Treffer.');
          },
        },
      ],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: () => maskingService(),
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

    await orchestrator.runTurn({ userMessage: `Was ist der aktuelle Stand von ${TERM}?` });

    assert.equal(seen.length, 1);
    const query = (seen[0] as { query: string }).query;
    assert.match(query, PLACEHOLDER, 'the sub-agent question keeps the placeholder');
    assert.ok(!query.includes('Falkenstein'));
  });

  it('remaskPromptValues turns an echoed user value back into its placeholder', async () => {
    const service = maskingService();
    const masked = await service.maskUserPrompt!({
      turnId: 't-1544',
      sessionId: 's-1544',
      text: `Notiz zu ${TERM} anlegen`,
    });
    assert.equal(masked.outcome, 'masked');
    const placeholder = PLACEHOLDER.exec(masked.outcome === 'masked' ? masked.maskedText : '')?.[0];
    assert.ok(placeholder);
    assert.equal(
      service.remaskPromptValues!('t-1544', `created /memories/${TERM}.md`),
      `created /memories/${placeholder}.md`,
    );
    assert.equal(service.remaskPromptValues!('other-turn', TERM), TERM, 'another turn has no map');
  });
});
