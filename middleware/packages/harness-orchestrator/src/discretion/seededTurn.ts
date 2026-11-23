/**
 * Spec 2042 §5.11 / §5.12 (INV-9) — a turn no person started still belongs
 * to a conversation. A trigger firing's turn has no origin of its own, but its
 * trigger was created in a conversation, and the trigger keeps that turn's
 * labels and the conversation's context key. The kernel runs the firing's
 * turn inside {@link runWithSeededDiscretion}; the agent runtime then starts
 * the turn's discretion state from the seed instead of an empty, unknown room:
 *
 *  - the context key is the creating conversation's, so what was said there
 *    flows back there;
 *  - the readers are that conversation's roster as the creating turn resolved
 *    it, stored on their own: never derived from the label set, whose room
 *    label is an intersection with older turns of the room;
 *  - the initial labels are everything the creating turn had read.
 *
 * Only the seeded agent's own turn takes the seed (a colleague it consults
 * starts from the consultation instead). The store is module-local: only code
 * that imports this module (the kernel's trigger executors) can seed a turn;
 * no plugin-facing service exposes it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { LabelSet, Readers } from './labels.js';

export interface SeededTurnDiscretion {
  /** The agent whose turn takes the seed. */
  readonly agentSlug: string;
  /** The creating conversation's context key. */
  readonly contextKey: string;
  /** Who reads that conversation, as the creating turn resolved it. */
  readonly readers: Readers;
  /** What the creating turn had read, its own conversation label included. */
  readonly labels: LabelSet;
  /**
   * The classifications every reader of that conversation could know when
   * the trigger was created (field rights, criterion 18). Absent = none: a
   * firing then restores, renders and bypasses nothing (fail closed).
   */
  readonly fieldClasses?: readonly string[];
}

const storage = new AsyncLocalStorage<SeededTurnDiscretion>();

/** Run `work` (the agent's turn) with its discretion seeded. */
export function runWithSeededDiscretion<T>(seed: SeededTurnDiscretion, work: () => Promise<T>): Promise<T> {
  return storage.run(seed, work);
}

/** The seed for `agentSlug`'s turn, or undefined. */
export function seededDiscretionFor(agentSlug: string): SeededTurnDiscretion | undefined {
  const seed = storage.getStore();
  return seed?.agentSlug === agentSlug ? seed : undefined;
}
