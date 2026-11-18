/**
 * The verifier's claim extraction asks for low effort and no thinking — on
 * Haiku 5.5 (default effort `medium`) it held the turn's `done` for 204–564
 * output tokens. The adapter drops the effort for a model without a ladder
 * (`llmProviderAnthropicAdapter.test.ts`), so the default Haiku 4.5 is safe.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ClaimExtractor, type ClaimExtractorOptions } from '@omadia/verifier';

describe('verifier model calls ask for low effort, no thinking', () => {
  it('claim extraction', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const llm = {
      complete: (req: unknown): Promise<unknown> => {
        seen.push(req as Record<string, unknown>);
        return Promise.resolve({
          content: [{ type: 'tool_call', id: 'call_1', name: 'record_claims', input: { claims: [] } }],
          finishReason: 'tool_calls',
          model: 'stub',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    } as unknown as ClaimExtractorOptions['llm'];
    await new ClaimExtractor({ llm, log: () => undefined }).extract({
      userMessage: 'Wie hoch sind die offenen Posten?',
      answer: 'Aktuell sind 36 Rechnungen offen.',
    });
    assert.ok(seen.length >= 1);
    for (const req of seen) {
      assert.equal(req['effort'], 'low');
      assert.equal(req['thinking'], 'off');
    }
  });
});
