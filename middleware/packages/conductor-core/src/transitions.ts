// One definition of "the edges a step leaves by", shared between the engine (which takes them)
// and the validator (which warns about them). Pure; no I/O.
//
// #1698 — these lived twice: the engine filtered `outgoing` against `step.fallbackTransitionId`
// while the validator re-derived the same set from its own transition map. A divergence between
// the two makes the publish-time warning lie about what the run will do, which is the one thing
// a warning must not do. Both now read from here.

import type { Step, Transition } from './types.js';

/** Every transition leaving `step`. */
export function outgoingTransitions(step: Step, transitions: Transition[]): Transition[] {
  return transitions.filter((t) => t.source === step.id);
}

/**
 * The happy-path edges: everything leaving the step except its declared deadline fallback.
 * The fallback is not a path the step's result chooses — it is the escape hatch a timeout or
 * an unmet postcondition fires — so guard evaluation never considers it.
 */
export function happyTransitions(step: Step, transitions: Transition[]): Transition[] {
  return outgoingTransitions(step, transitions).filter((t) => t.id !== step.fallbackTransitionId);
}

/**
 * Happy-path edges that carry no guard. Such an edge matches unconditionally, which is why a
 * rejected human step may not take one (#1698) and why the validator warns when a human step
 * has any.
 */
export function unguardedHappyTransitions(step: Step, transitions: Transition[]): Transition[] {
  return happyTransitions(step, transitions).filter((t) => t.guard === undefined);
}
