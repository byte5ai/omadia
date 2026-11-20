/**
 * The turn label set (spec 2042 §5.11): the union of the labels of everything
 * read in a turn. Held in a mutable box on the turn context, copied by
 * reference into every nested dispatch scope (same reason as
 * `TurnContextValue.memoryFileRead`), so a label added inside a tool dispatch
 * is visible to the egress checks of the whole turn.
 */

import { turnContext } from '../turnContext.js';
import { checkFlow, type FlowDecision } from './flowRule.js';
import {
  EMPTY_LABEL_SET,
  UNKNOWN_READERS,
  unionLabels,
  type DiscretionLabel,
  type LabelSet,
  type Readers,
} from './labels.js';

export interface DiscretionTurnState {
  /** Grows during the turn; never shrinks. */
  labels: LabelSet;
  /** The turn's own conversation context key, if the turn has one. */
  readonly contextKey?: string;
  /**
   * Who reads this turn's answer; `unknown` when the room is not known.
   * Resolved lazily (roster and identity lookups) and at most once.
   */
  readonly resolveReaders: () => Promise<Readers>;
}

export function createDiscretionTurnState(opts: {
  readonly contextKey?: string;
  readonly resolveReaders?: () => Promise<Readers>;
  readonly initial?: LabelSet;
}): DiscretionTurnState {
  return {
    labels: opts.initial ?? EMPTY_LABEL_SET,
    ...(opts.contextKey !== undefined ? { contextKey: opts.contextKey } : {}),
    resolveReaders: opts.resolveReaders ?? (() => Promise.resolve(UNKNOWN_READERS)),
  };
}

/** Add labels to the active turn's set. No-op outside a labelled turn. */
export function addTurnLabels(labels: LabelSet | readonly DiscretionLabel[]): void {
  const state = turnContext.current()?.discretion;
  if (!state) return;
  state.labels = unionLabels(state.labels, labels);
}

/** The active turn's discretion state, or undefined outside a labelled turn. */
export function currentDiscretion(): DiscretionTurnState | undefined {
  return turnContext.current()?.discretion;
}

/** The active turn's label set (empty outside a labelled turn). */
export function currentTurnLabels(): LabelSet {
  return turnContext.current()?.discretion?.labels ?? EMPTY_LABEL_SET;
}

/**
 * The full label set of a turn: everything it read plus its own conversation
 * label with the room's readers (a person's message carries "the conversation
 * context and its members"). Resolved lazily because the room needs lookups.
 */
export async function resolvedTurnLabels(state: DiscretionTurnState | undefined): Promise<LabelSet> {
  if (!state) return EMPTY_LABEL_SET;
  if (state.contextKey === undefined) return state.labels;
  const readers = await state.resolveReaders();
  return unionLabels(state.labels, [{ kind: 'context', key: state.contextKey, readers }]);
}

/**
 * The people-egress verdict for a turn's answer: may every reader of the
 * turn's conversation know everything the turn read? Undefined when there is
 * nothing to decide (no labelled turn, nothing read). The turn's own
 * conversation label always passes back to it, so it is not added here.
 */
export async function peopleEgressDecision(
  state: DiscretionTurnState | undefined,
): Promise<FlowDecision | undefined> {
  if (!state || state.labels.labels.length === 0) return undefined;
  const readers = await state.resolveReaders();
  return checkFlow(state.labels, {
    kind: 'people',
    ...(state.contextKey !== undefined ? { contextKey: state.contextKey } : {}),
    readers,
  });
}
