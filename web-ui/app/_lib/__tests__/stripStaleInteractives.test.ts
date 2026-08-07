import { describe, expect, it } from 'vitest';

import {
  stripStaleInteractives,
  type Message,
  type PendingMcpInput,
} from '../chatSessions';

/**
 * #544 W2-1 — a mutation run found this logic completely uncovered while it was
 * inline in `chat/page.tsx`, including the pre-existing `pendingUserChoice`
 * half. A stale MCP input form is the worst case: its `correlationId` is
 * single-use server-side, so re-submitting an old form can only fail.
 */

const MCP_INPUT: PendingMcpInput = {
  correlationId: 'corr-1',
  serverName: 'Kunden-CRM',
  serverId: 'srv-1',
  toolName: 'create_ticket',
  fields: [{ name: 'customerNumber', required: true }],
};

function assistant(over?: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'answer',
    tools: [],
    ...over,
  } as Message;
}

describe('#544 stripStaleInteractives', () => {
  it('MUTATION CHECK: strips a stale MCP input form', () => {
    const out = stripStaleInteractives([assistant({ pendingMcpInput: MCP_INPUT })]);
    expect(out[0]!.pendingMcpInput).toBeUndefined();
    // The key must be GONE, not merely falsy — the render guard is a truthiness
    // check, but an `undefined`-valued key would still serialize into storage.
    expect('pendingMcpInput' in out[0]!).toBe(false);
  });

  it('MUTATION CHECK: strips a stale choice card and follow-ups (pre-existing behaviour)', () => {
    const out = stripStaleInteractives([
      assistant({
        pendingUserChoice: { question: 'Q?', options: [{ label: 'A', value: 'a' }] },
        followUpOptions: [{ label: 'more', prompt: 'more' }],
      }),
    ]);
    expect('pendingUserChoice' in out[0]!).toBe(false);
    expect('followUpOptions' in out[0]!).toBe(false);
  });

  it('strips all three at once', () => {
    const out = stripStaleInteractives([
      assistant({
        pendingMcpInput: MCP_INPUT,
        pendingUserChoice: { question: 'Q?', options: [{ label: 'A', value: 'a' }] },
        followUpOptions: [{ label: 'more', prompt: 'more' }],
      }),
    ]);
    expect('pendingMcpInput' in out[0]!).toBe(false);
    expect('pendingUserChoice' in out[0]!).toBe(false);
    expect('followUpOptions' in out[0]!).toBe(false);
  });

  it('keeps everything else on the message', () => {
    const out = stripStaleInteractives([
      assistant({ pendingMcpInput: MCP_INPUT, content: 'keep me', turnId: 't1' }),
    ]);
    expect(out[0]!.content).toBe('keep me');
    expect(out[0]!.turnId).toBe('t1');
    expect(out[0]!.role).toBe('assistant');
  });

  it('MUTATION CHECK: returns untouched messages by IDENTITY', () => {
    const plain = assistant();
    const out = stripStaleInteractives([plain]);
    // Reference equality matters: React short-circuits re-renders on it, so a
    // version that always spread every message would re-render the whole
    // transcript on every send. `toEqual` would not catch that.
    expect(out[0]).toBe(plain);
  });

  it('does not mutate the input', () => {
    const input = assistant({ pendingMcpInput: MCP_INPUT });
    stripStaleInteractives([input]);
    expect(input.pendingMcpInput).toEqual(MCP_INPUT);
  });

  it('handles an empty transcript', () => {
    expect(stripStaleInteractives([])).toEqual([]);
  });
});
