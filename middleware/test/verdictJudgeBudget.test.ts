import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { VERDICT_JUDGE_MAX_TOKENS } from '../packages/harness-orchestrator/src/classifierBudgets.js';
import { createDataPlanGuard, createLlmDataPlanJudge } from '../packages/harness-orchestrator/src/dataPlanGuard.js';
import { createLlmIdentityJudge } from '../packages/harness-orchestrator/src/identityGuard/llmJudge.js';
import {
  createLlmSummaryJudge,
  createSummaryBoundaryGuard,
} from '../packages/harness-orchestrator/src/summaryBoundaryGuard.js';

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
  readonly temperature?: number;
}

function provider(seen: SeenRequest[], reply = 'PASS') {
  return {
    id: 'anthropic',
    complete: (req: SeenRequest) => {
      seen.push(req);
      return Promise.resolve({
        content: [{ type: 'text', text: reply }],
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
      // A reasoning effort with a temperature other than 1 is refused by some providers.
      assert.equal(req.temperature, undefined);
    }
  });

  it('a reply without a verdict is a failed check, not a broken boundary', async () => {
    const p = provider([], '');
    const boundaries = { custom: ['Never show salaries.'] };
    const plan = createDataPlanGuard({ boundaries, judge: createLlmDataPlanJudge({ provider: p, model: 'm' }) });
    const summary = createSummaryBoundaryGuard({ boundaries, judge: createLlmSummaryJudge({ provider: p, model: 'm' }) });
    const planVerdict = await plan({ description: 'list open invoices' } as never);
    const summaryVerdict = await summary('Three invoices are open.');
    assert.equal(planVerdict.allowed, false);
    assert.equal(summaryVerdict.allowed, false);
    assert.equal(!planVerdict.allowed && planVerdict.reason, 'the boundary check failed');
    assert.equal(!summaryVerdict.allowed && summaryVerdict.reason, 'the boundary check failed');
  });
});
