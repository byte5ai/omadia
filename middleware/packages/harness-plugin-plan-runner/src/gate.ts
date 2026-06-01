import type { LlmAccessor } from '@omadia/plugin-api';

/**
 * #133 (plan-as-data) slice E2 — the materialisation gate.
 *
 * A cheap Haiku classifier that decides whether a turn warrants an explicit
 * plan DAG. Simple Q&A stays latency/cost-neutral (no planning call); only
 * plan-worthy turns proceed to materialisation.
 */

export const GATE_MODEL = 'claude-haiku-4-5';

const GATE_SYSTEM = [
  'You are a planning gate for an AI assistant. Decide whether answering the',
  "user's request requires an explicit MULTI-STEP plan (several distinct",
  'sub-goals or tool steps that must be sequenced), or whether it can be',
  'answered DIRECTLY in a single step.',
  '',
  'Reply with exactly one word:',
  '  PLAN   — the request needs multiple sequenced sub-goals',
  '  DIRECT — a single-step answer suffices',
  'No other text.',
].join('\n');

/** Returns true when the turn should materialise a plan. Errs toward DIRECT
 *  (no plan) on any ambiguity or failure — a missed plan is cheaper than a
 *  spurious one. */
export async function shouldPlan(
  userMessage: string,
  llm: Pick<LlmAccessor, 'complete'>,
): Promise<boolean> {
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return false;
  try {
    const res = await llm.complete({
      model: GATE_MODEL,
      system: GATE_SYSTEM,
      messages: [{ role: 'user', content: trimmed }],
      maxTokens: 4,
      temperature: 0,
    });
    return res.text.trim().toUpperCase().startsWith('PLAN');
  } catch {
    return false;
  }
}
