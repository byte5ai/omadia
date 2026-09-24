import { describe, expect, it, vi } from 'vitest';

import { applyStreamEvent } from '../chatStreamEvents';
import type {
  ChatSession,
  Message,
  UseChatSessionsResult,
} from '../chatSessions';

/**
 * #617 — `applyStreamEvent` used to write through the active-session mutator,
 * which only ever reached the *currently active* session. A turn streaming
 * into a chat tab the user had switched away from therefore folded its events
 * into nothing. These tests pin the routing contract: the fold is addressed by the
 * turn's own session id, and the mutator handed over touches exactly the
 * pending message.
 */

function assistantMessage(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    startedAt: 1_000,
    streaming: true,
  };
}

function session(id: string): ChatSession {
  return {
    id,
    title: 'Background',
    createdAt: 1_000,
    updatedAt: 1_000,
    messages: [
      assistantMessage('other', 'untouched'),
      assistantMessage('pending-1', 'so far'),
    ],
  };
}

/**
 * Records the `(sessionId, mutator)` pair `applyStreamEvent` hands to the
 * store, so the test can both assert the routing and replay the mutator.
 */
function stubSessions(): {
  sessions: UseChatSessionsResult;
  mutateById: ReturnType<typeof vi.fn>;
} {
  const mutateById = vi.fn();
  return {
    sessions: { mutateById } as unknown as UseChatSessionsResult,
    mutateById,
  };
}

function applied(
  mutateById: ReturnType<typeof vi.fn>,
  target: ChatSession,
): ChatSession {
  const mutator = mutateById.mock.calls[0]?.[1] as (s: ChatSession) => ChatSession;
  return mutator(target);
}

describe('applyStreamEvent — writes are addressed by session id (#617)', () => {
  it('routes a text_delta to the session the turn belongs to and folds it into the pending message', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'text_delta',
      text: ' more',
    });

    expect(mutateById).toHaveBeenCalledTimes(1);
    expect(mutateById.mock.calls[0]?.[0]).toBe('bg');

    const before = session('bg');
    const next = applied(mutateById, before);
    expect(next.messages[1]?.content).toBe('so far more');
    // Sibling messages survive the fold untouched.
    expect(next.messages[0]).toBe(before.messages[0]);
    expect(next.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('replaces the content wholesale with the authoritative done answer', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'done',
      answer: 'the authoritative answer',
      toolCalls: 0,
      iterations: 1,
    });

    expect(mutateById.mock.calls[0]?.[0]).toBe('bg');

    const next = applied(mutateById, session('bg'));
    expect(next.messages[1]?.content).toBe('the authoritative answer');
    expect(next.messages[1]?.streaming).toBe(false);
  });
});

/**
 * #1008 — the `foreign` flag marks a tool call the subscription-CLI agent made
 * OUTSIDE omadia's loopback MCP server, i.e. a CLI built-in that slipped past
 * the OM-81 spawn gate. It has to survive the fold, or the trace cannot tell
 * such a call apart from an omadia tool.
 */
describe('applyStreamEvent — foreign tool calls (#1008)', () => {
  it('carries foreign from a tool_use onto the tool entry', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'tool_use',
      id: 'call-1',
      name: 'Bash',
      input: { command: 'whoami' },
      foreign: true,
    });

    const next = applied(mutateById, session('bg'));
    expect(next.messages[1]?.tools?.[0]?.foreign).toBe(true);
  });

  it('leaves an omadia tool call unmarked', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'tool_use',
      id: 'call-1',
      name: 'mcp__omadia__manage_routine',
      input: {},
    });

    const next = applied(mutateById, session('bg'));
    expect(next.messages[1]?.tools?.[0]?.foreign).toBeUndefined();
  });

  it('trusts a stamped tool_result even when the tool_use was missed', () => {
    // A reconnect mid-turn can deliver the result without its tool_use, so the
    // route's stamp on the result is authoritative on its own.
    const { sessions, mutateById } = stubSessions();
    const seeded = session('bg');
    const withTool: ChatSession = {
      ...seeded,
      messages: seeded.messages.map((msg) =>
        msg.id === 'pending-1'
          ? { ...msg, tools: [{ id: 'call-1', name: 'Bash' }] }
          : msg,
      ),
    };

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'tool_result',
      id: 'call-1',
      output: 'silviolange',
      durationMs: 12,
      foreign: true,
    });

    const next = applied(mutateById, withTool);
    expect(next.messages[1]?.tools?.[0]?.foreign).toBe(true);
    expect(next.messages[1]?.tools?.[0]?.output).toBe('silviolange');
  });
});

/**
 * #1094 — a turn that throws after a tool already committed arrives as `done`
 * (an `error` would make the next turn re-invoke the committed tool, #506).
 * The fold has to keep that turn distinguishable from a real answer, and the
 * machine marker the orchestrator sends in `answer` must never reach the
 * bubble — the old behavior was an English pseudo-success rendered as prose.
 */
describe('applyStreamEvent — degraded turns (#1094)', () => {
  const MARKER =
    '<turn-incomplete tools="memory,manage_widget" ref="turn-token-1"></turn-incomplete>';

  it('records the degraded state from the live event', () => {
    // The live shape: the orchestrator expands the marker into the localized
    // notice at the delivery boundary, so `answer` is prose and the machine
    // truth rides the event fields.
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'done',
      answer:
        'Dieser Turn wurde nicht abgeschlossen. Diese Aktionen waren bereits ausgeführt und sind wirksam: memory, manage_widget.\n\nDiese Antwort wurde von einem KI-System erzeugt.',
      toolCalls: 2,
      iterations: 2,
      degraded: true,
      committedTools: ['memory', 'manage_widget'],
      correlationId: 'turn-token-1',
    });

    const next = applied(mutateById, session('bg'));
    const folded = next.messages[1];
    expect(folded?.degradedTurn?.committedTools).toEqual([
      'memory',
      'manage_widget',
    ]);
    expect(folded?.degradedTurn?.correlationId).toBe('turn-token-1');
    expect(folded?.content).toContain('Dieser Turn wurde nicht abgeschlossen');
    // A degraded turn is not an error — the bubble must not flip to the
    // failure styling, which would contradict the committed side effect.
    expect(folded?.error).toBeUndefined();
  });

  it('recovers the degraded state from the persisted marker (server-side mirror)', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'done',
      answer: MARKER,
      toolCalls: 2,
      iterations: 2,
    });

    const folded = applied(mutateById, session('bg')).messages[1];
    expect(folded?.degradedTurn?.committedTools).toEqual([
      'memory',
      'manage_widget',
    ]);
    expect(folded?.degradedTurn?.correlationId).toBe('turn-token-1');
    expect(folded?.content).toBe('');
  });

  it('leaves an ordinary answer untouched', () => {
    const { sessions, mutateById } = stubSessions();

    applyStreamEvent(sessions, 'bg', 'pending-1', {
      type: 'done',
      answer: 'the authoritative answer',
      toolCalls: 1,
      iterations: 1,
    });

    const folded = applied(mutateById, session('bg')).messages[1];
    expect(folded?.degradedTurn).toBeUndefined();
    expect(folded?.content).toBe('the authoritative answer');
  });
});
