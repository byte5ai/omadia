import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import type { Message } from '../../_lib/chatSessions';
import { MessageRow } from '../page';

/**
 * OM-105 — the live status row kept running after the turn had already failed.
 *
 * A beta tester watched "••• STREAM LIVE · 163S · TOOL RUNNING · ITER 0 · …
 * · VERMUTLICH HÄNGT — STOP DRÜCKEN?" keep counting up directly underneath an
 * answer bubble that already read "CLI timed out after 120000ms". The row was
 * gated on `streaming === true || hasPendingTool`, and `hasPendingTool` never
 * clears on a failed turn: the tool call that was in flight when the stream
 * died never receives its result event, so its `output` stays `undefined`
 * forever. The clock therefore ran until the tab was closed, and told the user
 * to press a Stop button for a turn that had already stopped.
 *
 * `finishedAt` is the authoritative turn-end marker — `finalizePending` sets
 * it from a `finally`, so done, error and abort all land there. These tests
 * pin that it, and not the tool bookkeeping, decides whether the row shows.
 */

const NOOP = (): void => {};

function row(message: Message): void {
  renderWithIntl(
    <MessageRow
      message={message}
      disabled={false}
      onChoose={NOOP}
      onDiscardAutoPromoted={NOOP}
    />,
  );
}

function assistant(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'CLI timed out after 120000ms',
    startedAt: Date.now() - 163_000,
    tools: [],
    ...over,
  };
}

/** The in-flight tool call that never got its result — the stuck signal. */
const PENDING_TOOL = [
  { id: 'call-1', name: 'mcp__omadia__manage_routine', input: {} },
];

/** A liveness snapshot old enough to trip the "probably hung" hint. */
const STALE_LIVENESS = {
  sinceLastActivityMs: 120_000,
  iteration: 0,
  toolCallsThisIter: 1,
  phase: 'tool_running' as const,
};

function livenessVisible(): boolean {
  return screen.queryByText(/stream live/i) !== null;
}

describe('MessageRow liveness gate (OM-105)', () => {
  it('hides the live row once the turn ended, even with a tool left pending', () => {
    // The exact reported state: the stream died mid-tool-call, so the turn is
    // finished but the tool never reported back.
    row(
      assistant({
        streaming: false,
        finishedAt: Date.now(),
        error: true,
        tools: PENDING_TOOL,
        liveness: STALE_LIVENESS,
      }),
    );

    expect(livenessVisible()).toBe(false);
    // And with it the advice to press Stop on an already-stopped turn.
    expect(screen.queryByText(/stop/i)).toBeNull();
  });

  it('hides it on a clean finish that still carries a pending tool', () => {
    row(
      assistant({
        streaming: false,
        finishedAt: Date.now(),
        tools: PENDING_TOOL,
        liveness: STALE_LIVENESS,
      }),
    );

    expect(livenessVisible()).toBe(false);
  });

  it('still shows it while the turn is genuinely in flight', () => {
    // The guard must not throw out the feature it is guarding: an unfinished
    // turn is exactly what the row exists for.
    row(
      assistant({
        streaming: true,
        tools: PENDING_TOOL,
        liveness: STALE_LIVENESS,
      }),
    );

    expect(livenessVisible()).toBe(true);
  });

  it('still shows it for a pending tool before the turn has finished', () => {
    // `streaming` flips off between the model's last token and the tool's
    // result; the row has to survive that gap, which is why `hasPendingTool`
    // is in the condition at all.
    row(
      assistant({
        streaming: false,
        tools: PENDING_TOOL,
        liveness: STALE_LIVENESS,
      }),
    );

    expect(livenessVisible()).toBe(true);
  });

  it('renders German copy without the live row after a failed turn', () => {
    renderWithIntl(
      <MessageRow
        message={assistant({
          streaming: false,
          finishedAt: Date.now(),
          error: true,
          tools: PENDING_TOOL,
          liveness: STALE_LIVENESS,
        })}
        disabled={false}
        onChoose={NOOP}
        onDiscardAutoPromoted={NOOP}
      />,
      { locale: 'de' },
    );

    expect(screen.queryByText(/stream live/i)).toBeNull();
    expect(screen.queryByText(/vermutlich hängt/i)).toBeNull();
  });
});
