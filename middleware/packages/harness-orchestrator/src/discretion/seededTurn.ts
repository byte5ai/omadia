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
 *  - the readers are that conversation's, as the creating turn resolved them;
 *  - the initial labels are everything the creating turn had read.
 *
 * Only the seeded agent's own turn takes the seed (a colleague it consults
 * starts from the consultation instead). Kernel-only: plugins never reach it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { UNKNOWN_READERS, type LabelSet, type Readers } from './labels.js';

export interface SeededTurnDiscretion {
  /** The agent whose turn takes the seed. */
  readonly agentSlug: string;
  /** The creating conversation's context key. */
  readonly contextKey: string;
  /** What the creating turn had read, its own conversation label included. */
  readonly labels: LabelSet;
}

const SLOT = Symbol.for('omadia.discretion.seededTurn');

/** One store per process, even when the package is loaded twice. */
function storage(): AsyncLocalStorage<SeededTurnDiscretion> {
  const slots = globalThis as unknown as Record<symbol, AsyncLocalStorage<SeededTurnDiscretion> | undefined>;
  const existing = slots[SLOT];
  if (existing) return existing;
  const created = new AsyncLocalStorage<SeededTurnDiscretion>();
  slots[SLOT] = created;
  return created;
}

/** Run `work` (the agent's turn) with its discretion seeded. */
export function runWithSeededDiscretion<T>(seed: SeededTurnDiscretion, work: () => Promise<T>): Promise<T> {
  return storage().run(seed, work);
}

/** The seed for `agentSlug`'s turn, or undefined. */
export function seededDiscretionFor(agentSlug: string): SeededTurnDiscretion | undefined {
  const seed = storage().getStore();
  return seed?.agentSlug === agentSlug ? seed : undefined;
}

/** The readers of the seed's own conversation; unknown (fails closed) when its label is missing. */
export function seededReaders(seed: Pick<SeededTurnDiscretion, 'contextKey' | 'labels'>): Readers {
  const own = seed.labels.labels.find((l) => l.kind === 'context' && l.key === seed.contextKey);
  return own?.kind === 'context' ? own.readers : UNKNOWN_READERS;
}
