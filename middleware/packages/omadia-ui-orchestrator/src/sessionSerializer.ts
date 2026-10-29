import { type ChatStreamEvent } from '@omadia/channel-sdk';

/** Runs `make()`'s stream for `sessionId` behind every earlier stream of the
 *  same session (see {@link createSessionSerializer}). */
export type SessionSerializer = (
  sessionId: string,
  make: () => AsyncGenerator<ChatStreamEvent>,
) => AsyncGenerator<ChatStreamEvent>;

// Per-canvasSessionId write mutex (9b-3). A canvas turn mutates ONE shared
// surface: it counts revisions and patches a tree from a base revision. Two
// clients on the SAME canvas (multi-window, or a refresh racing a turn from a
// second socket) would otherwise interleave surface_* events at colliding
// revisions and force a resync. Each canvas turn/refresh for a session runs
// behind the previous one; classic turns (no canvasSessionId) never queue.
// The lock is held for the WHOLE stream and released in finally, so an abort
// (generator .return()) or a mid-stream throw always frees the next turn.
export function createSessionSerializer(): SessionSerializer {
  const sessionTail = new Map<string, Promise<void>>();
  async function* serializePerSession(
    sessionId: string,
    make: () => AsyncGenerator<ChatStreamEvent>,
  ): AsyncGenerator<ChatStreamEvent> {
    const prev = sessionTail.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    sessionTail.set(sessionId, tail);
    // a failed/aborted prior turn must never wedge the queue
    await prev.catch(() => {});
    try {
      yield* make();
    } finally {
      release();
      // GC: drop the entry only if no later turn chained after ours
      if (sessionTail.get(sessionId) === tail) sessionTail.delete(sessionId);
    }
  }
  return serializePerSession;
}
