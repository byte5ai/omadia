/**
 * Spec 2042 follow-up — a withheld answer stays out of the agent's memory,
 * and the turn's record says what the identity guard decided.
 *
 * The orchestrator writes a turn's record (session-log row → Knowledge-Graph
 * turn → the next turns' recall) INSIDE its turn, before the answer reaches
 * the identity guard, which wraps it from outside and decides last (on the
 * stream's `done`, after the verifier and the privacy render). A withheld
 * draft was therefore recorded as if it had been said, and every later turn
 * read it back: live, Dark Clippy's blocked draft ("if I introduced myself as
 * … that was wrong") was repeated by every following "wer bist du" turn.
 *
 * The record gate closes that gap without moving the guard: the record writer
 * reports every row it writes to the gate of the running agent turn and holds
 * back what would learn from the answer (fact extraction). Once the guard has
 * decided, it resolves the gate: every recorded row gets the verdict, a
 * withheld answer's row loses its text (the user's message stays), and the
 * held work runs only for an answer that was kept.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { TurnIdentityGuardVerdict } from '@omadia/plugin-api';

import type { SessionLogEntry } from '../sessionLogger.js';

/** What the guard decided about the turn's answer. */
export interface AnswerVerdict {
  readonly kept: boolean;
  /** Absent: the guard checked nothing (a system notice, the verifier's). */
  readonly guard?: TurnIdentityGuardVerdict;
}

/** Rewrites one recorded row with the verdict. Expected not to throw. */
export type RecordedRowAmend = (verdict: AnswerVerdict) => Promise<void>;

export class AnswerRecordGate {
  readonly #rows: RecordedRowAmend[] = [];
  readonly #held: Array<() => void> = [];
  #verdict: AnswerVerdict | undefined;

  /** A row of this turn was written; it is amended once the guard decides. */
  recorded(amend: RecordedRowAmend): void {
    if (this.#verdict) {
      void amend(this.#verdict);
      return;
    }
    this.#rows.push(amend);
  }

  /** Work that learns from the answer (fact extraction): runs once the answer
   *  is kept, never for a withheld one. */
  whenKept(work: () => void): void {
    if (this.#verdict) {
      if (this.#verdict.kept) work();
      return;
    }
    this.#held.push(work);
  }

  /** The guard's verdict, once: amends every recorded row, releases or drops
   *  the held work. */
  async resolve(verdict: AnswerVerdict): Promise<void> {
    if (this.#verdict) return;
    this.#verdict = verdict;
    const held = this.#held.splice(0);
    if (verdict.kept) for (const work of held) work();
    await Promise.all(this.#rows.splice(0).map((amend) => amend(verdict)));
  }
}

/** The row of a withheld answer: the user's message, no answer (nor its
 *  masked twin) for the agent's memory. The notice the user saw is the
 *  channel's: only the user-visible web-chat mirror keeps it. */
export function withoutAnswer(entry: SessionLogEntry, notice?: string): SessionLogEntry {
  return {
    ...entry,
    assistantAnswer: '',
    ...(entry.maskedView !== undefined ? { maskedView: { ...entry.maskedView, assistantAnswer: '' } } : {}),
    ...(notice !== undefined ? { transcriptAnswer: notice } : {}),
  };
}

const storage = new AsyncLocalStorage<AnswerRecordGate>();

/** The record gate of the agent turn running here, if a guard opened one. */
export function currentAnswerRecordGate(): AnswerRecordGate | undefined {
  return storage.getStore();
}

/** Runs `fn` with `gate` as the turn's record gate. */
export function runWithAnswerRecordGate<T>(gate: AnswerRecordGate, fn: () => Promise<T>): Promise<T> {
  return storage.run(gate, fn);
}

/** The generator twin of {@link runWithAnswerRecordGate}: every step of the
 *  inner stream runs with `gate` (an async generator resumes in its caller's
 *  context otherwise). */
export async function* runGeneratorWithAnswerRecordGate<T>(
  gate: AnswerRecordGate,
  make: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  const inner = storage.run(gate, () => make()[Symbol.asyncIterator]());
  let exhausted = false;
  try {
    for (;;) {
      const step = await storage.run(gate, () => inner.next());
      if (step.done) {
        exhausted = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!exhausted && inner.return) {
      await storage.run(gate, async () => {
        await inner.return?.(undefined);
      });
    }
  }
}
