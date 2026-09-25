import { describe, expect, it } from 'vitest';

import { mergeProactiveFromRemote, reconcileNewerRemote } from '../chatProactiveMerge';
import type { ChatSession, Message } from '../chatSessions';

/**
 * #1071 — the web chat hydrates once per page load, so a routine delivery the
 * server appended later only shows up through this additive re-read. It may
 * add server-written proactive messages; it must never replace local state.
 */

function msg(id: string, role: 'user' | 'assistant', startedAt: number, extra: Partial<Message> = {}): Message {
  return { id, role, content: id, startedAt, ...extra };
}

function session(messages: Message[], updatedAt: number): ChatSession {
  return { id: 's1', title: 'Chat', createdAt: 0, updatedAt, messages };
}

const DELIVERY = msg('p1', 'assistant', 15, { proactive: { deliveredAt: 15, routineId: 'r1' } });

describe('mergeProactiveFromRemote', () => {
  it('inserts a missing delivery before the next later user message', () => {
    const local = session(
      [msg('u1', 'user', 10), msg('a1', 'assistant', 11), msg('u2', 'user', 20), msg('a2', 'assistant', 21)],
      30,
    );
    const remote = session([msg('u1', 'user', 10), msg('a1', 'assistant', 11), DELIVERY], 40);

    const merged = mergeProactiveFromRemote(local, remote);

    expect(merged.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'p1', 'u2', 'a2']);
    expect(merged.updatedAt).toBe(40);
  });

  it('appends at the end when no later user message exists', () => {
    const local = session([msg('u1', 'user', 10), msg('a1', 'assistant', 11)], 50);
    const remote = session([msg('u1', 'user', 10), msg('a1', 'assistant', 11), DELIVERY], 40);

    const merged = mergeProactiveFromRemote(local, remote);

    expect(merged.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'p1']);
    expect(merged.updatedAt).toBe(50);
  });

  it('ignores remote differences that are not proactive deliveries', () => {
    const local = session([msg('u1', 'user', 10), msg('a1', 'assistant', 11)], 30);
    const remote = session(
      [msg('u1', 'user', 10), msg('a1', 'assistant', 11, { content: 'changed' }), msg('x', 'assistant', 12)],
      40,
    );

    expect(mergeProactiveFromRemote(local, remote)).toBe(local);
  });

  it('is idempotent', () => {
    const local = session([msg('u1', 'user', 10)], 30);
    const remote = session([msg('u1', 'user', 10), DELIVERY], 40);

    const once = mergeProactiveFromRemote(local, remote);
    const twice = mergeProactiveFromRemote(once, remote);

    expect(twice).toBe(once);
    expect(twice.messages.filter((m) => m.id === 'p1')).toHaveLength(1);
  });
});

describe('reconcileNewerRemote', () => {
  const U1 = msg('u1', 'user', 10);
  const A1 = msg('a1', 'assistant', 11);
  const U2 = msg('u2', 'user', 12);
  const A2 = msg('a2', 'assistant', 13);

  it('keeps the local turns and folds the delivery when only a delivery differs', () => {
    const local = session([U1, A1], 30);
    const remote = { ...session([U1, A1, DELIVERY], 40), title: 'Renamed' };

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'p1']);
    expect(result.title).toBe('Renamed');
    expect(result.updatedAt).toBe(40);
    expect(pushLocal).toBe(false);
  });

  it('keeps a local turn the server never received and asks for a catch-up PUT', () => {
    // The turn-2 PUT failed; a delivery then made the server copy newer.
    const local = session([U1, A1, U2, A2], 30);
    const remote = session([U1, A1, DELIVERY], 40);

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'p1']);
    expect(pushLocal).toBe(true);
  });

  it('takes the server copy when it has a turn the local copy lacks', () => {
    const local = session([U1, A1], 30);
    const remote = session([U1, A1, U2], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('takes the server copy when its turns diverge from the local ones', () => {
    const local = session([U1, A1, U2], 30);
    const remote = session([U1, msg('x', 'assistant', 11), DELIVERY], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('takes the server copy when it holds no turns (a clear or reset)', () => {
    const local = session([U1, A1], 30);
    const remote = session([DELIVERY], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });
});
