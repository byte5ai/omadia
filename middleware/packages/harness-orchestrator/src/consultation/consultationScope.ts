/**
 * Spec 2042 §5.4 / ADR-0018 — the run of a consulted agent B on behalf of A.
 *
 * The kernel runs B's ordinary `ChatAgent.chat()` inside this scope; B's
 * orchestrator reads it at every tool offer and dispatch and narrows the turn
 * to the consultation envelope:
 *  - tools only from plugins in `allowedPluginIds` (the grant's allowed
 *    capabilities ∩ B's grants ∩ A's grants, computed by the kernel);
 *  - no kernel tools that act or read on their own (memory writes, calendar,
 *    choice cards, follow-ups, chat roster), no `consult` (depth 1);
 *  - `memoryAccess: 'discreet'`: recall and the knowledge graph only, and only
 *    when B runs `members` context memory with A's audience; `'none'`: none.
 *
 * A process-wide store (like `runAsEngineTurn`): this package can be loaded
 * twice, and a scope entered through one copy must be visible to the other.
 */

import { processWideStore } from '../facilitatorAgent.js';
import type { LabelSet } from '../discretion/labels.js';

export type ConsultationMemoryAccess = 'none' | 'discreet';

export interface ConsultationRunScope {
  /** B: the consulted agent, whose orchestrator the narrowing applies to. */
  readonly agentSlug: string;
  /** A: the consulting agent. */
  readonly fromAgentSlug: string;
  readonly fromTurnId: string;
  readonly callId: string;
  /** Plugin ids (or `mcp:<serverId>`) whose tools B may use in this run. */
  readonly allowedPluginIds: ReadonlySet<string>;
  readonly memoryAccess: ConsultationMemoryAccess;
  /**
   * Spec 2042 §5.11 — what A's turn had read when it asked: B's turn starts
   * with these labels, so nothing A may not send somewhere can leave through
   * B (an integration write of B is checked against A's labels too).
   */
  readonly initialLabels?: LabelSet;
  /**
   * Filled by B's orchestrator when its turn ends: the turn's label set
   * (everything B read, its conversation included) and B's answer as its
   * model wrote it, before the privacy shield restored values for the user
   * (the `redacted` disclosure view).
   */
  readonly result: ConsultationRunResult;
}

export interface ConsultationRunResult {
  labels?: LabelSet;
  wireAnswer?: string;
  /** True when B's turn ran with a privacy shield (the wire answer is masked). */
  shielded?: boolean;
  /**
   * Set by the broker when B's deadline passed: B's run cannot be aborted,
   * so from then on it gets no tool at all and its answer is discarded.
   */
  expired?: boolean;
}

const consultationRuns = processWideStore<ConsultationRunScope>('omadia.consultation.run');

/** Kernel-only: the consultation broker is the single caller. */
export function runAsConsultation<T>(scope: ConsultationRunScope, fn: () => T): T {
  return consultationRuns.run(scope, fn);
}

export function currentConsultation(): ConsultationRunScope | undefined {
  return consultationRuns.getStore();
}

/** Kernel tools that may serve a consultation run when memory is `discreet`. */
const DISCREET_MEMORY_TOOLS: ReadonlySet<string> = new Set(['query_knowledge_graph']);

/**
 * May agent `agentSlug` use tool `toolName` (owned by `ownerPluginId`,
 * `undefined` for a kernel tool) right now? Outside a consultation run of
 * this agent: always (the ordinary grant checks apply). Inside: only what
 * the consultation envelope allows. Privacy-shield verb tools (`v4_*`) work
 * on the run's own datasets and stay available.
 */
export function consultationAllowsTool(
  agentSlug: string,
  toolName: string,
  ownerPluginId: string | undefined,
): boolean {
  const scope = currentConsultation();
  if (!scope || scope.agentSlug !== agentSlug) return true;
  // Past the deadline the answer is discarded: nothing may run any more.
  if (scope.result.expired === true) return false;
  if (toolName.startsWith('v4_')) return true;
  // B writes nothing to its memory from a consultation.
  if (toolName === 'memory') return false;
  if (ownerPluginId === undefined) {
    return scope.memoryAccess === 'discreet' && DISCREET_MEMORY_TOOLS.has(toolName);
  }
  return scope.allowedPluginIds.has(ownerPluginId);
}

/** True while `agentSlug` itself answers a consultation (it may not consult further). */
export function isConsultationRunOf(agentSlug: string): boolean {
  return currentConsultation()?.agentSlug === agentSlug;
}

/** What the consulted agent's model gets for a tool outside the envelope. */
export function consultationToolRefusal(name: string): string {
  return `Error: tool \`${name}\` is not available while answering a colleague's consultation.`;
}
