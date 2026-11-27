import type { ChatStreamEvent } from '@omadia/channel-sdk';

/**
 * #2342 / ADR-0316 — a streamed tool output reaches the client only while
 * the answer's people-egress check would let the answer through.
 *
 * A streamed `done` that discretion withholds takes its text back
 * (`text_retract`), but a client keeps whatever tool outputs it was sent:
 * signed download links, raw read results. The check depends only on the
 * labels the turn has collected, and labels only grow (a tool's read labels
 * the turn before its `tool_result` is yielded). So at each `tool_result` /
 * `sub_tool_result` the hold asks whether the check would refuse NOW:
 *
 *  - no: the event streams live, as before — an output that passes now
 *    carries nothing the readers may not know;
 *  - yes: the event is held. The answer is then withheld as well, and
 *    `settle(true)` turns each held `tool_result` into one without its
 *    output (the row shows the call finished) and drops held
 *    `sub_tool_result`s. Should the answer still go out, `settle(false)`
 *    hands the full events back.
 *
 * Either way a call yields exactly one `tool_result`.
 */
export class ToolOutputHold {
  private held: readonly ChatStreamEvent[] = [];

  /** `refusesNow` must not throw; a failing check answers `true` (hold). */
  constructor(private readonly refusesNow: () => Promise<boolean>) {}

  /** The event to stream now, or `undefined` when it is held. */
  async pass(event: ChatStreamEvent): Promise<ChatStreamEvent | undefined> {
    if (event.type !== 'tool_result' && event.type !== 'sub_tool_result') return event;
    if (!(await this.refusesNow())) return event;
    this.held = [...this.held, event];
    return undefined;
  }

  /** The held events to send before `done`; the hold is empty afterwards. */
  settle(answerWithheld: boolean): readonly ChatStreamEvent[] {
    const held = this.held;
    this.held = [];
    if (!answerWithheld) return held;
    return held.flatMap((event) => (event.type === 'tool_result' ? [{ ...event, output: '' }] : []));
  }
}
