/**
 * Pending tool outputs, kept apart per turn (#1961, ADR-0177).
 *
 * A plugin creates one tool instance at activation and every turn shares it.
 * A single instance-wide buffer therefore handed a file or diagram to whichever
 * concurrent turn drained first, even in another user's chat. Outputs are
 * filed under the id of the turn whose tool call produced them, and a drain
 * returns only the finishing turn's entries.
 *
 * A call without a turn id (outside a turn, or a host that does not state one)
 * files under {@link NO_TURN}; only a drain without a turn id takes those.
 *
 * Bounded: a turn that never drains (crashed before its end) must not grow the
 * map forever, so the oldest turn is dropped once {@link MAX_PENDING_TURNS}
 * turns hold entries.
 */

/** Bucket for outputs produced with no turn id. */
const NO_TURN = '';

/** Turns with undrained outputs kept at once before the oldest is dropped. */
export const MAX_PENDING_TURNS = 256;

export class PerTurnBuffer<T> {
  readonly #byTurn = new Map<string, T[]>();

  /** File `item` under `turnId` (or the no-turn bucket). */
  push(turnId: string | undefined, item: T): void {
    const key = turnId ?? NO_TURN;
    const existing = this.#byTurn.get(key);
    if (existing) {
      existing.push(item);
      return;
    }
    if (this.#byTurn.size >= MAX_PENDING_TURNS) {
      const oldest = this.#byTurn.keys().next().value;
      if (oldest !== undefined) this.#byTurn.delete(oldest);
    }
    this.#byTurn.set(key, [item]);
  }

  /** Return and forget the outputs of `turnId`; undefined when it has none. */
  drain(turnId: string | undefined): T[] | undefined {
    const key = turnId ?? NO_TURN;
    const items = this.#byTurn.get(key);
    if (!items) return undefined;
    this.#byTurn.delete(key);
    return items;
  }

  /** Number of turns holding undrained outputs (tests, diagnostics). */
  get pendingTurns(): number {
    return this.#byTurn.size;
  }
}
