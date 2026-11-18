// Deterministic step advancement (FR-001, FR-002, FR-006). Pure; no I/O.

import type { Decision, JsonObject, JsonValue, PostconditionOutcome, Transition, WorkflowGraph } from './types.js';
import { evaluatePredicate } from './predicate.js';
import { happyTransitions, outgoingTransitions } from './transitions.js';

/**
 * #1698 — an explicit rejection of a human step: the result carries `approved: false`.
 *
 * The executor produces exactly this shape for both approval modes — the raw response in
 * fail-open mode, the normalized `{ ...response, approved: isApproved(response, true) }` under
 * `human.strictApproval`, and the aggregate under `quorum: 'all'` — so the engine needs no
 * knowledge of either flag. An ABSENT or non-boolean `approved` is never a rejection here: in
 * fail-open mode that case is approval by definition, and under strict the executor has already
 * turned it into a literal `false`. The check therefore never changes the path of a step nobody
 * rejected, which is what keeps this fix off every non-approval workflow.
 */
function isRejection(stepResult: JsonValue): boolean {
  return (
    typeof stepResult === 'object' &&
    stepResult !== null &&
    !Array.isArray(stepResult) &&
    (stepResult as JsonObject).approved === false
  );
}

/**
 * #1698 — the one decision a rejected human step can reach when the author declared no path for
 * a refusal. Named instead of folded into `no_transition_no_fallback` because the graph is not
 * broken: the approver said no, and nothing in the graph asked about that answer.
 */
function rejectedStuck(stepId: string, happy: Transition[], postcondition: PostconditionOutcome): Decision {
  const detail =
    happy.length === 0
      ? 'the step declares no outgoing transition at all'
      : `no transition guards for a rejection — an unguarded transition never carries one (${happy.map((t) => t.id).join(', ')})`;
  return {
    kind: 'stuck',
    code: 'approval_rejected_no_transition',
    message: `human step '${stepId}' was rejected (approved: false) and ${detail}`,
    nodeIds: [stepId, ...happy.map((t) => t.id)],
    postcondition,
  };
}

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
 *   #1698 — one exception to "an unguarded edge always matches": a human step whose result
 *   says `approved: false` is an explicit REJECTION, and a rejection may only leave the step
 *   on an edge whose guard asks for it — the deadline fallback included, and even when the
 *   step is terminal. See `isRejection` and `rejectionAllows`.
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

  const outgoing = outgoingTransitions(step, graph.transitions);
  const fallbackId = step.fallbackTransitionId;
  const fallback = fallbackId !== undefined ? graph.transitions.find((t) => t.id === fallbackId) : undefined;

  if (fallbackId !== undefined && !fallback) {
    return { kind: 'stuck', code: 'fallback_transition_missing', message: `step '${currentStepId}' fallbackTransitionId '${fallbackId}' not found`, nodeIds: [currentStepId, fallbackId], postcondition: postOutcome };
  }

  // #1698 — a rejected human step must not leave on an UNGUARDED edge. Such an edge matches
  // unconditionally, so without this an approval that was explicitly refused advanced exactly
  // as one that was granted, and ran the action it was meant to gate. Only an edge whose guard
  // asks for the rejection may fire — and that holds for the deadline fallback too: it carries
  // no answer either, and firing it would report an explicit "no" as a missed deadline (an
  // escalation step then reads "was not decided within 48 hours" to the operator).
  const rejected = step.kind === 'human' && isRejection(stepResult);
  const rejectionAllows = (t: Transition): boolean =>
    !rejected || (t.guard !== undefined && evaluatePredicate(t.guard, scope));

  // 1. Unmet postcondition → fallback (never a happy-path transition).
  if (hasPost && !postMet) {
    if (fallback && rejectionAllows(fallback)) {
      return { kind: 'advance', transitionId: fallback.id, targetStepId: fallback.target, reason: 'postcondition_unmet_fallback', postcondition: 'unmet' };
    }
    if (rejected) {
      return rejectedStuck(step.id, happyTransitions(step, graph.transitions), 'unmet');
    }
    return { kind: 'stuck', code: 'postcondition_unmet_no_fallback', message: `step '${currentStepId}' postcondition unmet and no fallback transition declared`, nodeIds: [currentStepId], postcondition: 'unmet' };
  }

  // 2. Postcondition met (or absent) → evaluate happy-path guards.
  const happy = happyTransitions(step, graph.transitions);
  const matched = happy.filter((t) => (t.guard === undefined ? !rejected : evaluatePredicate(t.guard, scope)));

  if (matched.length === 1) {
    const t = matched[0]!;
    return { kind: 'advance', transitionId: t.id, targetStepId: t.target, reason: 'guard_matched', postcondition: postOutcome };
  }
  if (matched.length > 1) {
    return { kind: 'stuck', code: 'ambiguous_guards', message: `step '${currentStepId}' has multiple matching transitions: ${matched.map((t) => t.id).join(', ')}`, nodeIds: matched.map((t) => t.id), postcondition: postOutcome };
  }

  // 3. No happy-path matched.
  if (fallback && rejectionAllows(fallback)) {
    return { kind: 'advance', transitionId: fallback.id, targetStepId: fallback.target, reason: 'no_transition_matched_fallback', postcondition: postOutcome };
  }
  // #1698 — a rejection is reported, never completed. This is checked BEFORE the terminal case
  // on purpose: a terminal human step gates nothing, but ending such a run `complete` makes a
  // refusal indistinguishable from an approval in the run list and in every webhook.
  if (rejected) {
    return rejectedStuck(step.id, happy, postOutcome);
  }
  if (outgoing.length === 0) {
    return { kind: 'complete', postcondition: postOutcome };
  }
  return { kind: 'stuck', code: 'no_transition_no_fallback', message: `step '${currentStepId}' has outgoing transitions but none matched and no fallback declared`, nodeIds: [currentStepId, ...outgoing.map((t) => t.id)], postcondition: postOutcome };
}
