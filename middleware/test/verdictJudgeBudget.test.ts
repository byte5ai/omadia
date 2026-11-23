import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { VERDICT_JUDGE_MAX_TOKENS } from '../packages/harness-orchestrator/src/classifierBudgets.js';
import { createLlmDataPlanJudge } from '../packages/harness-orchestrator/src/dataPlanGuard.js';
import { createLlmIdentityJudge } from '../packages/harness-orchestrator/src/identityGuard/llmJudge.js';
import { createLlmSummaryJudge } from '../packages/harness-orchestrator/src/summaryBoundaryGuard.js';

/**
 * Spec 2042 §5.5, #2085, criterion 33 — the PASS / BLOCK judges run on the
 * agent's own model when it has no classifier model. On an always-thinking
 * model (Opus 5.5, Fable) thinking counts toward `max_tokens`: with a budget
 * for the verdict alone the reply had no text, and every judged answer, plan
 * or summary of such an agent was refused (live: `identity judge gave no
 * verdict: ""`).
 */

interface SeenRequest {
  readonly maxTokens?: number;
  readonly effort?: string;
  readonly thinking?: string;
}

function provider(seen: SeenRequest[]) {
  return {
    id: 'anthropic',
    complete: (req: SeenRequest) => {
      seen.push(req);
      return Promise.resolve({
        content: [{ type: 'text', text: 'PASS' }],
        finishReason: 'stop',
        model: 'claude-opus-5-5',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  } as never;
}

describe('the PASS/BLOCK judges are budgeted for a thinking model', () => {
  it('room for thinking before the verdict, at low effort, thinking off where the model allows', async () => {
    const seen: SeenRequest[] = [];
    const p = provider(seen);
    const identity = createLlmIdentityJudge({ provider: p, model: 'claude-opus-5-5' });
    const plan = createLlmDataPlanJudge({ provider: p, model: 'claude-opus-5-5' });
    const summary = createLlmSummaryJudge({ provider: p, model: 'claude-opus-5-5' });

    const verdict = await identity.judge(
      { text: 'Ich bin Minerva.', speakerName: 'Minerva', colleagues: [] },
      new AbortController().signal,
    );
    assert.equal(verdict.verdict, 'pass');
    assert.equal(await plan.judge('list open invoices', ['no salaries']), 'pass');
    assert.equal(await summary.judge('Three invoices are open.', ['no salaries']), 'pass');

    assert.equal(seen.length, 3);
    for (const req of seen) {
      assert.equal(req.maxTokens, VERDICT_JUDGE_MAX_TOKENS);
      assert.ok((req.maxTokens ?? 0) >= 512, 'a verdict-only budget leaves no text after thinking');
      assert.equal(req.effort, 'low');
      assert.equal(req.thinking, 'off');
    }
  });
});
