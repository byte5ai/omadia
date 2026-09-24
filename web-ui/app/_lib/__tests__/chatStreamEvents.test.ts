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
