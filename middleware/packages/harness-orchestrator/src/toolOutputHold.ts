import type { ChatStreamEvent } from '@omadia/channel-sdk';

/**
 * #2342 / ADR-0316 — tool outputs of a streamed turn wait for the answer's
 * people-egress check.
 *
 * A streamed `done` that discretion withholds takes its text back
 * (`text_retract`), but a client keeps whatever tool outputs it was sent:
 * signed download links, raw read results. So while the answer may still be
 * withheld, a `tool_result` streams without its output (`output: ''`, the
 * row shows the call finished) and a `sub_tool_result` is held whole. When
 * the answer goes out, `release()` hands the full events back to send just
 * before `done`; a client that maps results by id then fills the rows in.
 * When the answer is withheld, `drop()` discards them and the client never
 * sees an output of the turn.
 *
 * Inactive (no discretion state on the turn, a consultation run): every
 * event passes unchanged, as before.
 */
export class ToolOutputHold {
  private held: readonly ChatStreamEvent[] = [];

  constructor(private readonly isActive: () => boolean) {}

  /** The event to stream now: itself, its output-less twin, or nothing. */
  pass(event: ChatStreamEvent): ChatStreamEvent | undefined {
    if (event.type !== 'tool_result' && event.type !== 'sub_tool_result') return event;
    if (!this.isActive()) return event;
    this.held = [...this.held, event];
    return event.type === 'tool_result' ? { ...event, output: '' } : undefined;
  }

  /** The held events, in arrival order; the hold is empty afterwards. */
  release(): readonly ChatStreamEvent[] {
    const out = this.held;
    this.held = [];
    return out;
  }

  /** Discard the held outputs: the answer they belong to is withheld. */
  drop(): void {
    this.held = [];
  }
}
