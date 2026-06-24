import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider } from '@omadia/llm-provider';
import {
  IssueReformulationError,
  reformulateIssue,
} from '../../src/issues/issueReformulator.js';

function providerReturning(text: string): LlmProvider {
  return {
    id: 'fake',
    capabilities: {},
    complete: () =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ kind: 'unknown', retryable: false }),
  } as unknown as LlmProvider;
}

function providerThrowing(): LlmProvider {
  return {
    id: 'fake',
    capabilities: {},
    complete: () => Promise.reject(new Error('boom')),
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ kind: 'unknown', retryable: false }),
  } as unknown as LlmProvider;
}

describe('reformulateIssue', () => {
  it('parses a plain JSON object', async () => {
    const result = await reformulateIssue({
      provider: providerReturning('{"title":"Fix the crash","body":"## Summary\\nIt crashes."}'),
      model: 'm',
      rawText: 'app stürzt ab',
      category: 'bug',
    });
    assert.equal(result.title, 'Fix the crash');
    assert.match(result.body, /Summary/);
  });

  it('parses a fenced JSON object', async () => {
    const result = await reformulateIssue({
      provider: providerReturning(
        '```json\n{"title":"Add dark mode","body":"## Summary\\nPlease."}\n```',
      ),
      model: 'm',
      rawText: 'dark mode bitte',
      category: 'feature',
    });
    assert.equal(result.title, 'Add dark mode');
  });

  it('throws on malformed output', async () => {
    await assert.rejects(
      () =>
        reformulateIssue({
          provider: providerReturning('sorry, I cannot do that'),
          model: 'm',
          rawText: 'x',
          category: 'improvement',
        }),
      IssueReformulationError,
    );
  });

  it('wraps a provider failure', async () => {
    await assert.rejects(
      () =>
        reformulateIssue({
          provider: providerThrowing(),
          model: 'm',
          rawText: 'x',
          category: 'bug',
        }),
      IssueReformulationError,
    );
  });
});
