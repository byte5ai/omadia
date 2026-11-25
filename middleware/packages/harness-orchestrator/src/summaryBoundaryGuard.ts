/**
 * Spec 2042 §6 criterion 33, §5.12 fast-path row — the agent's boundaries
 * over the fast lane's planner summary.
 *
 * The summary is `prose`: a fast model wrote its template, and it goes out
 * under the agent's name. The full agent loop reads its boundaries in the
 * system prompt; the planner never does. So before a fast-lane answer (new or
 * from the cache) is released, its summary is checked against the agent's
 * boundaries the same way a data plan is (`dataPlanGuard.ts`): the presets
 * with a deterministic text constraint first, every other rule (presets
 * without one and the free-text boundaries) by a short model call on the
 * summary with figures masked. Anything but a clear PASS refuses, and so do
 * an error and a timeout (fail-closed). A refused summary is never shown: the
 * turn goes to the agent's full loop, which answers under its boundaries.
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import { getBoundaryPreset, type DataPlanVerdict, type ProfileQualityConfig } from '@omadia/plugin-api';
import { recordUsage, usageTokensFromLlm } from '@omadia/usage-telemetry';
import { VERDICT_JUDGE_MAX_TOKENS, VERDICT_JUDGE_REASONING } from './classifierBudgets.js';
import { parseJudgeVerdict } from './identityGuard/llmJudge.js';

export const SUMMARY_JUDGE_TIMEOUT_MS = 8_000;

/** The agent's check of one fast-lane summary. Fails closed. */
export type SummaryBoundaryGuard = (summary: string) => Promise<DataPlanVerdict>;

/** The model layer: does this text break one of these rules? */
export interface SummaryBoundaryJudge {
  judge(text: string, rules: readonly string[]): Promise<'pass' | 'block'>;
}

const URL = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;
/** A ranking of individuals in words: top-N, league tables, "best customer". */
const RANKING =
  /\btop[\s-]?\d+\b|\branking\b|\brangliste\b|\b(?:platz|rang|place)\s*\d+\b|\b(?:best(?:e[nrs]?)?|größte[nrs]?|largest|biggest|worst|schlechteste[nrs]?)\s+(?:customers?|clients?|kunden?|employees?|mitarbeiter(?:in|innen)?|partners?)\b/i;

/** The deterministic text constraint behind a preset, where one exists. */
const TEXT_CONSTRAINTS: Readonly<Record<string, (text: string) => string | undefined>> = {
  'no-external-links': (t) => (URL.test(t) ? 'the summary contains an external link' : undefined),
  'no-individual-rankings': (t) =>
    RANKING.test(t) ? 'the summary ranks individual customers or people' : undefined,
};

/** Figures are system data, not the planner's words: the judge sees none. */
export function maskFigures(text: string): string {
  return text.replace(/\d[\d.,'\u00a0 ]*\d|\d/g, '‹n›');
}

export function createLlmSummaryJudge(options: {
  readonly provider: LlmProvider;
  readonly model: string;
}): SummaryBoundaryJudge {
  return {
    async judge(text, rules) {
      const res = await options.provider.complete({
        model: options.model,
        maxTokens: VERDICT_JUDGE_MAX_TOKENS,
        ...VERDICT_JUDGE_REASONING,
        system: [
          'You check a short answer an AI agent is about to send against the rules its operator set.',
          'Rules:',
          ...rules.map((r) => `- ${r}`),
          'Answer BLOCK if sending the text would break a rule; PASS otherwise.',
          'Reply with exactly one word: PASS or BLOCK.',
        ].join('\n'),
        messages: [textMessage('user', text)],
      });
      recordUsage({
        source: 'summary-boundary-guard',
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
 * The summary guard of one agent. With no boundaries it allows every
 * summary; with rules a model must judge but no judge it refuses.
 */
export function createSummaryBoundaryGuard(options: {
  readonly boundaries: ProfileQualityConfig['boundaries'] | undefined;
  readonly judge?: SummaryBoundaryJudge;
  readonly timeoutMs?: number;
}): SummaryBoundaryGuard {
  const presets = options.boundaries?.presets ?? [];
  const custom = (options.boundaries?.custom ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  // Presets without a text constraint go to the model in their curated wording.
  const modelRules = [
    ...presets
      .filter((id) => TEXT_CONSTRAINTS[id] === undefined)
      .map((id) => getBoundaryPreset(id)?.prompt)
      .filter((p): p is string => p !== undefined),
    ...custom,
  ];
  return async (summary: string): Promise<DataPlanVerdict> => {
    for (const id of presets) {
      const why = TEXT_CONSTRAINTS[id]?.(summary);
      if (why) return { allowed: false, reason: `${why} (boundary "${id}")`, layer: 'preset' };
    }
    if (modelRules.length === 0) return { allowed: true };
    const judge = options.judge;
    if (!judge) return { allowed: false, reason: 'the agent has boundaries and no model to check them', layer: 'model' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        judge.judge(maskFigures(summary), modelRules),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? SUMMARY_JUDGE_TIMEOUT_MS);
        }),
      ]);
      if (verdict === 'pass') return { allowed: true };
      return {
        allowed: false,
        reason: verdict === 'timeout' ? 'the boundary check timed out' : "the summary breaks one of the agent's boundaries",
        layer: 'model',
      };
    } catch {
      return { allowed: false, reason: 'the boundary check failed', layer: 'model' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
