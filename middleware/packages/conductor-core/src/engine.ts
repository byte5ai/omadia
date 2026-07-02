// Deterministic step advancement (FR-001, FR-002, FR-006). Pure; no I/O.

import type { Decision, JsonObject, JsonValue, PostconditionOutcome, WorkflowGraph } from './types.js';
import { evaluatePredicate } from './predicate.js';

/**
 * Given a completed step's result and the run context, deterministically decide the next move:
 *   1. Evaluate the step's exit postcondition.
 *      - If unmet → fire the step's declared fallback transition (or `stuck` if none).
 *   2. If met (or absent) → evaluate the guards of the outgoing happy-path transitions
 *      (every outgoing transition except the fallback).
 *      - Exactly one matches  → advance via it.
 *      - More than one match  → `stuck` (ambiguous_guards) — a deterministic, surfaced error.
 *      - None match           → fire the fallback, else `complete` if terminal, else `stuck`.
 *
 * Identical (graph, currentStepId, stepResult, ctx) always yields an identical Decision.
 */
export function nextStep(
  graph: WorkflowGraph,
  currentStepId: string,
  stepResult: JsonValue,
  ctx: JsonObject,
): Decision {
  const step = graph.steps.find((s) => s.id === currentStepId);
  if (!step) {
    return { kind: 'stuck', code: 'unknown_step', message: `no step with id '${currentStepId}'`, nodeIds: [currentStepId], postcondition: 'n/a' };
  }

  const scope = { ctx, stepResult };
  const hasPost = step.postcondition !== undefined;
  const postMet = hasPost ? evaluatePredicate(step.postcondition!, scope) : true;
  const postOutcome: PostconditionOutcome = hasPost ? (postMet ? 'met' : 'unmet') : 'n/a';

  const outgoing = graph.transitions.filter((t) => t.source === currentStepId);
  const fallbackId = step.fallbackTransitionId;
  const fallback = fallbackId !== undefined ? graph.transitions.find((t) => t.id === fallbackId) : undefined;

  if (fallbackId !== undefined && !fallback) {
    return { kind: 'stuck', code: 'fallback_transition_missing', message: `step '${currentStepId}' fallbackTransitionId '${fallbackId}' not found`, nodeIds: [currentStepId, fallbackId], postcondition: postOutcome };
  }

  // 1. Unmet postcondition → fallback (never a happy-path transition).
  if (hasPost && !postMet) {
    if (fallback) {
      return { kind: 'advance', transitionId: fallback.id, targetStepId: fallback.target, reason: 'postcondition_unmet_fallback', postcondition: 'unmet' };
    }
    return { kind: 'stuck', code: 'postcondition_unmet_no_fallback', message: `step '${currentStepId}' postcondition unmet and no fallback transition declared`, nodeIds: [currentStepId], postcondition: 'unmet' };
  }

  // 2. Postcondition met (or absent) → evaluate happy-path guards.
  const happy = outgoing.filter((t) => t.id !== fallbackId);
  const matched = happy.filter((t) => (t.guard === undefined ? true : evaluatePredicate(t.guard, scope)));

  if (matched.length === 1) {
    const t = matched[0]!;
    return { kind: 'advance', transitionId: t.id, targetStepId: t.target, reason: 'guard_matched', postcondition: postOutcome };
  }
  if (matched.length > 1) {
    return { kind: 'stuck', code: 'ambiguous_guards', message: `step '${currentStepId}' has multiple matching transitions: ${matched.map((t) => t.id).join(', ')}`, nodeIds: matched.map((t) => t.id), postcondition: postOutcome };
  }

  // 3. No happy-path matched.
  if (fallback) {
    return { kind: 'advance', transitionId: fallback.id, targetStepId: fallback.target, reason: 'no_transition_matched_fallback', postcondition: postOutcome };
  }
  if (outgoing.length === 0) {
    return { kind: 'complete', postcondition: postOutcome };
  }
  return { kind: 'stuck', code: 'no_transition_no_fallback', message: `step '${currentStepId}' has outgoing transitions but none matched and no fallback declared`, nodeIds: [currentStepId, ...outgoing.map((t) => t.id)], postcondition: postOutcome };
}
