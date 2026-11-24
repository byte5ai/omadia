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
 * Sent only to a model whose catalogue entry declares the level. The adapters
 * now drop an effort the model cannot take themselves (Anthropic's
 * `acceptsEffort`, OpenAI's reasoning-model gate), with a one-time warning;
 * the catalogue check keeps a sub-agent from sending a level its model does
 * not offer at all, so it never relies on that fallback. Unknown model → no
 * effort, never a broken turn.
 */
export type SubAgentEffortFor = (providerId: string, model: string) => EffortLevel | undefined;

export function subAgentEffortFor(level: EffortLevel | undefined): SubAgentEffortFor | undefined {
  if (level === undefined) return undefined;
  return (providerId, model) =>
    resolveModelRef(`${providerId}:${model}`)?.effortLevels?.includes(level) === true ? level : undefined;
}
