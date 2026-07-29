/**
 * #440 follow-up — the GATE EPOCH: one monotonic counter that fences every
 * vector write against the verdict it was computed under.
 *
 * WHY. Stopping the backfill handle only clears its timers
 * (`EmbeddingBackfillHandle.stop`). A `runSweep()` that is already executing
 * keeps its own captured `embeddingClient` and finishes its 20-row batch, one
 * `await embed()` network round trip per row, writing
 * `embedding = <old-model vector>, embedding_attempts = 0` as it goes. The hot
 * path has the same shape: resolve the client, `await embed(text)`, UPDATE.
 *
 * A same-width provider switch drains `clear_pending` and re-opens writes in
 * between. Anything that lands after that drain is an old-model vector in a
 * corpus whose registry names the new model — and it is unrecoverable by
 * construction: `clear_pending` is FALSE so no clear will revisit it, and
 * `embedding IS NOT NULL` so the sweep's `WHERE embedding IS NULL` never picks
 * it up again. `/health` reports `embeddings: true` throughout. The invariant
 * `clear_pending` rests on ("a non-NULL vector is an old-model vector") is
 * simply false from then on, with no path back.
 *
 * THE FENCE. `startGateRunner` bumps its epoch in the same synchronous block
 * that swaps the approved client. Every writer captures the epoch BEFORE its
 * `await embed()` and re-reads it immediately before the write; a moved epoch
 * means the verdict this vector was computed under is gone, so the write is
 * dropped. Checking before the embed would fix nothing — the window IS the
 * embed.
 *
 * WHY NOT AN `AbortSignal` ON THE HANDLE. That fences the sweep only. The hot
 * path never sees the handle, and `neonKnowledgeGraph` / `processMemoryStore`
 * carry exactly the same resolve → await → UPDATE window.
 *
 * WHY NOT RE-RESOLVE THE CLIENT AFTER THE AWAIT. The resolve-once contract is
 * load-bearing: a mid-flight re-resolve turns a clean "no client, skip" into a
 * TypeError inside a transaction. The fix belongs at the write, not at the
 * resolve.
 */

/** Reads the gate runner's current epoch. Must be a pure synchronous read. */
export type GateEpochReader = () => number;

/**
 * The epoch a runner starts on, and the one a writer with no gate wired
 * reports. Pre-#440 callers and unit tests construct without a reader and are
 * therefore never fenced — byte-for-byte their previous behaviour.
 */
export const INITIAL_GATE_EPOCH = 0;

export interface GateEpochFence {
  /** The epoch captured at the start of the operation. */
  readonly epoch: number;
  /**
   * Has the gate re-evaluated since capture? `true` means the vector in hand
   * was produced by a client the current verdict no longer approves, so it
   * must not be written.
   */
  moved(): boolean;
}

/**
 * Capture the current epoch for one operation.
 *
 * A reader is deliberately NOT wrapped in try/catch. It is a closure over a
 * number owned by the gate runner and cannot throw in practice; if a caller
 * wires something that can, the throw propagates out of the writer, and where
 * it lands differs per writer — so do not read this as a blanket containment
 * guarantee:
 *
 *  - `embeddingBackfill.runSweep` captures INSIDE its own try, so a throw is
 *    logged and `running` is lowered in the `finally`. That placement is
 *    load-bearing: outside it, one throw would leave `running` TRUE and every
 *    later tick would short-circuit for the process lifetime.
 *  - `neonKnowledgeGraph`'s two embedders capture just ABOVE their try, so a
 *    throw rejects a fire-and-forget call rather than counting an attempt.
 *  - `processMemoryStore.write`/`edit` capture outside any try at all, so a
 *    throw surfaces as a rejected promise to the caller — before either has
 *    opened a transaction or written anything.
 *
 * All three are loud and leave no partial state behind, which is the property
 * that matters — the quieter alternatives are "never fence again" and "never
 * write again", and both fail silently.
 */
export function captureGateEpoch(
  read: GateEpochReader | undefined,
): GateEpochFence {
  if (read === undefined) {
    return { epoch: INITIAL_GATE_EPOCH, moved: () => false };
  }
  const captured = read();
  return { epoch: captured, moved: () => read() !== captured };
}
