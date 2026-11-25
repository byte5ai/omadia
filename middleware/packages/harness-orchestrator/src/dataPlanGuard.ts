/**
 * #2085 — the agent's boundary check of a data plan (spec 2042 §5.13 1a,
 * criterion 35): presets first, deterministically; free-text boundaries by a
 * short model call on the plan's description (no data, no input values).
 * Runs as the agent's internal helper, on the model its policy uses for
 * classification. Anything but a clear PASS refuses; an error or a timeout
 * refuses too (fail-closed).
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import {
  checkDataPlanPresets,
  dataPlanText,
  type DataPlanDescription,
  type DataPlanGuard,
  type DataPlanVerdict,
  type ProfileQualityConfig,
} from '@omadia/plugin-api';
import { recordUsage, usageTokensFromLlm } from '@omadia/usage-telemetry';
import { VERDICT_JUDGE_MAX_TOKENS, VERDICT_JUDGE_REASONING } from './classifierBudgets.js';
import { parseJudgeVerdict } from './identityGuard/llmJudge.js';

export const DATA_PLAN_JUDGE_TIMEOUT_MS = 8_000;

/** The model layer: does this plan break one of these rules? */
export interface DataPlanJudge {
  judge(planText: string, rules: readonly string[]): Promise<'pass' | 'block'>;
}

export function createLlmDataPlanJudge(options: { readonly provider: LlmProvider; readonly model: string }): DataPlanJudge {
  return {
    async judge(planText, rules) {
      const res = await options.provider.complete({
        model: options.model,
        maxTokens: VERDICT_JUDGE_MAX_TOKENS,
        ...VERDICT_JUDGE_REASONING,
        system: [
          'You check a planned data query of an AI agent against the rules its operator set.',
          'Rules:',
          ...rules.map((r) => `- ${r}`),
          'Answer BLOCK if running the query as described would break a rule; PASS otherwise.',
          'Reply with exactly one word: PASS or BLOCK.',
        ].join('\n'),
        messages: [textMessage('user', planText)],
      });
      recordUsage({
        source: 'data-plan-guard',
        model: options.model,
        provider: options.provider.id,
        ...usageTokensFromLlm(res.usage),
      });
      // No verdict (an empty reply) is a failed check, not a broken rule:
      // it throws, and the guard refuses as "the boundary check failed".
      return parseJudgeVerdict(collectText(res.content)).verdict;
    },
  };
}

/**
 * The guard of one agent. With no boundaries it allows every plan; with
 * free-text boundaries but no judge it refuses (the rules cannot be checked).
 */
export function createDataPlanGuard(options: {
  readonly boundaries: ProfileQualityConfig['boundaries'] | undefined;
  readonly judge?: DataPlanJudge;
  readonly timeoutMs?: number;
}): DataPlanGuard {
  const presets = options.boundaries?.presets ?? [];
  const custom = (options.boundaries?.custom ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  return async (plan: DataPlanDescription): Promise<DataPlanVerdict> => {
    const deterministic = checkDataPlanPresets(plan, presets);
    if (!deterministic.allowed || custom.length === 0) return deterministic;
    const judge = options.judge;
    if (!judge) return { allowed: false, reason: 'the agent has free-text boundaries and no model to check them', layer: 'model' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        judge.judge(dataPlanText(plan), custom),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? DATA_PLAN_JUDGE_TIMEOUT_MS);
        }),
      ]);
      if (verdict === 'pass') return { allowed: true };
      return {
        allowed: false,
        reason: verdict === 'timeout' ? 'the boundary check timed out' : "the plan breaks one of the agent's boundaries",
        layer: 'model',
      };
    } catch {
      return { allowed: false, reason: 'the boundary check failed', layer: 'model' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
