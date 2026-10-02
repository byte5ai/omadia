/**
 * Runs async work one call at a time per turn id; different turns never wait
 * for each other. A rejected call does not stall the calls queued behind it,
 * and a turn's queue entry is dropped once it has drained.
 */
export type TurnSerialQueue = <T>(turnId: string, run: () => Promise<T>) => Promise<T>;

export function createTurnSerialQueue(): TurnSerialQueue {
  const tails = new Map<string, Promise<void>>();
  return <T>(turnId: string, run: () => Promise<T>): Promise<T> => {
    const result = (tails.get(turnId) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(turnId, tail);
    void tail.then(() => {
      if (tails.get(turnId) === tail) tails.delete(turnId);
    });
    return result;
  };
}
