import { resolveModelRef, type EffortLevel } from '@omadia/llm-provider';

/**
 * Reasoning effort for a sub-agent's model calls (`SUB_AGENT_EFFORT`).
 *
 * Sub-agents used to send no effort at all, so an always-thinking model ran at
 * its API default — measured live: an accounting sub-agent spent 87 s and
 * ~21k output tokens over five iterations on one delegated question. Effort
 * only bounds the THINKING: tool results arrive as input and the answer keeps
 * the full `max_tokens` budget, so a large deterministic result still fits.
 *
 * Sent only to a model whose catalogue entry declares the level: the Anthropic
 * adapter forwards `output_config.effort` unchecked, and a model without the
 * knob (Haiku 4.5, …) answers 400. Unknown model → no effort, never a broken
 * turn.
 */
export type SubAgentEffortFor = (providerId: string, model: string) => EffortLevel | undefined;

export function subAgentEffortFor(level: EffortLevel | undefined): SubAgentEffortFor | undefined {
  if (level === undefined) return undefined;
  return (providerId, model) =>
    resolveModelRef(`${providerId}:${model}`)?.effortLevels?.includes(level) === true ? level : undefined;
}
