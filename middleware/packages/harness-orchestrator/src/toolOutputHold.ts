import type { ChatStreamEvent } from '@omadia/channel-sdk';

type ToolResultEvent = Extract<ChatStreamEvent, { type: 'tool_result' }>;
type SubToolResultEvent = Extract<ChatStreamEvent, { type: 'sub_tool_result' }>;

/**
 * #2342 / ADR-0316 — a streamed tool output reaches the client only while
 * the answer's people-egress check would let the answer through.
 *
 * A streamed `done` that discretion withholds takes its text back
 * (`text_retract`), but a client keeps whatever tool outputs it was sent:
 * signed download links, raw read results. The check depends only on the
 * labels the turn has collected, and labels only grow. A top-level tool
 * labels the turn inside its dispatch, before its `tool_result` is yielded,
 * so at each `tool_result` the hold asks whether the check would refuse NOW:
 *
 *  - no: the event streams live, as before — an output that passes now
 *    carries nothing the readers may not know;
 *  - yes: the event is held. The answer is then withheld as well, and
 *    `settle(true)` turns each held `tool_result` into one without its
 *    output (the row shows the call finished). Should the answer still go
 *    out, `settle(false)` hands the full events back.
 *
 * A sub-agent's inner results (`sub_tool_result`) arrive BEFORE their
 * parent tool returns and labels the turn (a shield bypass inside it, for
 * one, is only classified then). So they wait for their parent: they go out
 * just before the parent's `tool_result` when that passes, are held with it
 * when it does not, and are dropped for a withheld answer.
 *
 * Either way a call yields exactly one `tool_result`.
 */
export class ToolOutputHold {
  private held: readonly ChatStreamEvent[] = [];
  private subsByParent: ReadonlyMap<string, readonly SubToolResultEvent[]> = new Map();

  /** `refusesNow` must not throw; a failing check answers `true` (hold). */
  constructor(private readonly refusesNow: () => Promise<boolean>) {}

  /** The events to stream now (none while held). */
  async pass(event: ChatStreamEvent): Promise<readonly ChatStreamEvent[]> {
    if (event.type === 'sub_tool_result') {
      const subs = this.subsByParent.get(event.parentId) ?? [];
      this.subsByParent = new Map([...this.subsByParent, [event.parentId, [...subs, event]]]);
      return [];
    }
    if (event.type !== 'tool_result') return [event];
    const withSubs = [...this.takeSubs(event.id), event];
    if (!(await this.refusesNow())) return withSubs;
    this.held = [...this.held, ...withSubs];
    return [];
  }

  /** The held events to send before `done`; the hold is empty afterwards. */
  settle(answerWithheld: boolean): readonly ChatStreamEvent[] {
    const held = this.held;
    this.held = [];
    // Inner results whose parent never returned have nothing to wait for.
    this.subsByParent = new Map();
    if (!answerWithheld) return held;
    return held.flatMap((event): ToolResultEvent[] => (event.type === 'tool_result' ? [{ ...event, output: '' }] : []));
  }

  private takeSubs(parentId: string): readonly SubToolResultEvent[] {
    const subs = this.subsByParent.get(parentId) ?? [];
    if (subs.length === 0) return subs;
    const rest = new Map(this.subsByParent);
    rest.delete(parentId);
    this.subsByParent = rest;
    return subs;
  }
}
