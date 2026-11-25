/**
 * Identity guard, model layer (#2046, spec 2042 §5.5): a short classifier
 * call that decides whether an agent's (masked) text speaks as someone else
 * or puts words in a colleague's mouth. Runs as the agent's internal helper,
 * on a model its policy allows (the cheap classifier model when it has one).
 * Anything but a clear PASS is a block; an error or timeout is handled by the
 * guard as `unavailable` (fail-closed).
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import { recordUsage, usageTokensFromLlm } from '@omadia/usage-telemetry';

import { VERDICT_JUDGE_MAX_TOKENS, VERDICT_JUDGE_REASONING } from '../classifierBudgets.js';

import type { IdentityJudge, IdentityJudgeRequest, IdentityJudgeVerdict } from './guard.js';

/** How much of the answer the judge sees, from its end. */
const JUDGE_MAX_CHARS = 8_000;

function system(request: IdentityJudgeRequest): string {
  const colleagues = request.colleagues.length > 0 ? request.colleagues.join(', ') : '(none named)';
  return [
    `You check a chat answer written by an AI agent named "${request.speakerName}".`,
    `Colleagues mentioned: ${colleagues}.`,
    'Answer BLOCK if the text does any of these:',
    '- the agent presents itself as anyone other than itself (another agent or a person);',
    '- the agent claims to be human or denies being an AI;',
    "- the agent states, quotes or paraphrases what a colleague said, thinks, recommends or decided (\"Mira thinks …\", \"according to Mira …\").",
    'Answer PASS for everything else, including plain mentions such as "Mira can help with that, write to her",',
    `the agent introducing itself as "${request.speakerName}" and saying that it is an AI.`,
    'Reply with exactly one word: PASS or BLOCK.',
  ].join('\n');
}

/**
 * The judge's verdict: its FIRST word, in whatever markup the model put
 * around it (`**PASS**`, `"Block".`, `PASS – nothing wrong`). A reply that
 * does not open with PASS or BLOCK ("DO NOT PASS", an empty reply) is no
 * verdict: it throws, and the guard fails closed as `unavailable`, not as a
 * pass. Exported for tests.
 */
export function parseJudgeVerdict(reply: string): IdentityJudgeVerdict {
  const first = /\p{L}+/u.exec(reply)?.[0]?.toUpperCase();
  if (first === 'PASS') return { verdict: 'pass' };
  if (first === 'BLOCK') return { verdict: 'block', reason: 'BLOCK' };
  throw new Error(`identity judge gave no verdict: ${JSON.stringify(reply.slice(0, 40))}`);
}

export function createLlmIdentityJudge(options: {
  readonly provider: LlmProvider;
  readonly model: string;
}): IdentityJudge {
  return {
    async judge(request: IdentityJudgeRequest, signal: AbortSignal): Promise<IdentityJudgeVerdict> {
      // The provider API takes no abort signal: a timed-out call finishes in
      // the background (bounded by VERDICT_JUDGE_MAX_TOKENS) and its verdict is
      // ignored; the guard has already failed closed.
      if (signal.aborted) throw new Error('identity judge aborted');
      const res = await options.provider.complete({
        model: options.model,
        // Sized for thinking: an always-thinking model counts it toward the
        // cap. Low effort, and no thinking where the model allows it: the
        // guard's timeout runs while the judge thinks.
        maxTokens: VERDICT_JUDGE_MAX_TOKENS,
        ...VERDICT_JUDGE_REASONING,
        system: system(request),
        // The END of the answer: the guard sends all text so far, and the
        // sentence under check is the newest one.
        messages: [textMessage('user', request.text.slice(-JUDGE_MAX_CHARS))],
      });
      recordUsage({
        source: 'identity-guard',
        model: options.model,
        provider: options.provider.id,
        ...usageTokensFromLlm(res.usage),
      });
      return parseJudgeVerdict(collectText(res.content));
    },
  };
}
