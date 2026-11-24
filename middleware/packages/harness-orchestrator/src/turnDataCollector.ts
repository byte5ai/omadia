/**
 * #2085 — the per-turn collector of side-channel data (spec 2042 §5.13).
 *
 * A data action the agent asks for during its turn (the kernel tool
 * `deliver_data`) runs in the harness and adds its result here; the agent's
 * model gets a status only. At the end of the turn the orchestrator puts the
 * collected payloads on the answer: `ChatTurnResult.data` on the buffered
 * path, the `done` event on the stream ({@link Orchestrator} —
 * `attachSideChannelData`). That is the one place the data joins the answer;
 * the speaker/emitter contract (#2045) emits it as `data` emissions from
 * there.
 *
 * The collector lives on the turn context by reference, so every nested
 * dispatch scope of the turn adds to the same one. A verifier-wrapped request
 * shares one collector across its passes: a re-entry replays `deliver_data`
 * from the request's tool ledger without running it again, and the retry's
 * answer must carry the data the first pass delivered.
 */

import { withoutDataText, type ChatTurnResult } from '@omadia/channel-sdk';
import type { DataPayload } from '@omadia/plugin-api';

/** Payloads one turn may deliver. */
export const MAX_DATA_PAYLOADS_PER_TURN = 5;

export type CollectOutcome =
  | { readonly accepted: true; readonly index: number }
  | { readonly accepted: false; readonly reason: 'limit_reached' };

export class TurnDataCollector {
  private readonly payloads: DataPayload[] = [];
  private withheld = false;

  add(payload: DataPayload): CollectOutcome {
    if (this.payloads.length >= MAX_DATA_PAYLOADS_PER_TURN) {
      return { accepted: false, reason: 'limit_reached' };
    }
    this.payloads.push(payload);
    return { accepted: true, index: this.payloads.length - 1 };
  }

  /**
   * #2079 — the answer was refused as a whole (discretion): nothing collected
   * goes out with it, on this pass or a later one of the same request.
   */
  withhold(): void {
    this.withheld = true;
  }

  /** A snapshot of what was collected, in order; empty once withheld. */
  list(): readonly DataPayload[] {
    return this.withheld ? [] : [...this.payloads];
  }
}

/** A buffered turn's result with the collector's payloads as `data`. */
export function withSideChannelData(
  result: ChatTurnResult,
  collector: TurnDataCollector,
): ChatTurnResult {
  const data = collector.list();
  return data.length > 0 ? { ...result, data } : result;
}

/**
 * A `done` event whose `answer` holds the data rendering, with `data` and
 * `textWithoutData` (the answer without that rendering) beside it. Unchanged
 * without data.
 */
export function withTextWithoutData<T extends { readonly answer: string }>(
  done: T,
  data: readonly DataPayload[] | undefined,
): T & { data?: readonly DataPayload[]; textWithoutData?: string } {
  if (!data || data.length === 0) return done;
  return { ...done, data, textWithoutData: withoutDataText(done.answer, data) };
}
