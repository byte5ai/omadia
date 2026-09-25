import { describe, expect, it, vi } from 'vitest';

import { hasNoTurns, mergeProactiveFromRemote, reconcileNewerRemote } from '../chatProactiveMerge';
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
    // A fold is not a sync: raising the clock to the server's would hide a
    // local turn whose PUT failed from the next hydration's catch-up.
    expect(merged.updatedAt).toBe(30);
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
    const local = { ...session([U1, A1, U2, A2], 30), title: 'Quarterly numbers' };
    const remote = { ...session([U1, A1, DELIVERY], 40), title: 'Neuer Chat' };

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'p1']);
    expect(pushLocal).toBe(true);
    // The server never received this browser's last write, so its title can
    // be the default the failed PUT would have replaced; adopting it rolled
    // the chat back to "Neuer Chat" and the catch-up PUT persisted that.
    expect(result.title).toBe('Quarterly numbers');
    // A failed catch-up must still look unsettled to the next load.
    expect(result.updatedAt).toBe(30);
  });

  it('keeps the local clock and title when a mirrored turn still needs its catch-up PUT', () => {
    const local = { ...session([U1, A1, U2, A2], 30), title: 'Quarterly numbers' };
    const remote = {
      ...session(
        [U1, A1, msg('srv-u-12', 'user', 12, { content: 'u2' }), msg('srv-a-14', 'assistant', 12, { content: 'a2' }), DELIVERY],
        40,
      ),
      title: 'Neuer Chat',
    };

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(pushLocal).toBe(true);
    expect(result.updatedAt).toBe(30);
    expect(result.title).toBe('Quarterly numbers');
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

  it('takes the server copy when a same-id local answer is only partial', () => {
    // The tab closed right after turn 2's PUT, before the debounced local
    // write caught up: localStorage holds a truncated copy under the SAME id.
    const local = session([U1, A1, U2, { ...A2, content: 'a' }], 30);
    const remote = session([U1, A1, U2, { ...A2, content: 'a2 in full' }, DELIVERY], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('takes the server copy when a same-id local answer is still streaming', () => {
    const local = session([U1, A1, U2, { ...A2, streaming: true }], 30);
    const remote = session([U1, A1, U2, A2, DELIVERY], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('keeps a same-id local answer that differs from the server copy only in whitespace', () => {
    const local = session([U1, { ...A1, content: 'a1\n' }], 30);
    const remote = session([U1, A1, DELIVERY], 40);

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'p1']);
    expect(result.messages[1]?.content).toBe('a1\n');
    expect(pushLocal).toBe(false);
  });

  // The in-process runtime's SessionLogger mirrors every web-chat turn into the
  // server copy under `srv-u-<startedAt>` / `srv-a-<finishedAt>` ids before the
  // client PUT lands; only that PUT swaps them for the client's ids.
  const MIRRORED_U2 = msg('srv-u-12', 'user', 12, { content: 'u2' });
  const MIRRORED_A2 = msg('srv-a-14', 'assistant', 12, { content: 'a2', finishedAt: 14 });

  it('keeps a local turn whose PUT failed when the server holds only its mirrored copy', () => {
    // Production shape on the in-process runtime: turn 2's PUT failed, the
    // mirror had already written it, then a delivery made the server newer.
    const richA1 = { ...A1, attachments: [{ kind: 'image', url: '/x.png' }] } as unknown as Message;
    const local = session([U1, richA1, U2, A2], 30);
    const remote = session([U1, A1, MIRRORED_U2, MIRRORED_A2, DELIVERY], 40);

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'p1']);
    expect((result.messages[1] as unknown as Record<string, unknown>)['attachments']).toEqual([
      { kind: 'image', url: '/x.png' },
    ]);
    // The catch-up PUT replaces the srv-* ids with the client's.
    expect(pushLocal).toBe(true);
  });

  it('matches a mirrored turn on trimmed content', () => {
    const local = session([U1, A1, U2, { ...A2, content: 'a2\n' }], 30);
    const remote = session([U1, A1, MIRRORED_U2, { ...MIRRORED_A2, content: '  a2' }, DELIVERY], 40);

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'p1']);
    expect(pushLocal).toBe(true);
  });

  it('keeps local turns ahead of a mirrored prefix and asks for a catch-up PUT', () => {
    const U3 = msg('u3', 'user', 16);
    const A3 = msg('a3', 'assistant', 17);
    const local = session([U1, A1, U2, A2, U3, A3], 30);
    const remote = session([U1, A1, MIRRORED_U2, MIRRORED_A2, DELIVERY], 40);

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'p1', 'u3', 'a3']);
    expect(pushLocal).toBe(true);
  });

  it('lets the mirror win over a partial local answer (mid-stream reload)', () => {
    const local = session([U1, A1, U2, { ...A2, content: 'a' }], 30);
    const remote = session([U1, A1, MIRRORED_U2, MIRRORED_A2, DELIVERY], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('lets the mirror win over a local answer that is still streaming', () => {
    const local = session([U1, A1, U2, { ...A2, streaming: true }], 30);
    const remote = session([U1, A1, MIRRORED_U2, MIRRORED_A2], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('lets the mirror win when the local copy has no answer for the mirrored turn yet', () => {
    const local = session([U1, A1, U2], 30);
    const remote = session([U1, A1, MIRRORED_U2, MIRRORED_A2], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('does not match a mirrored message against a local one of the other role', () => {
    const local = session([U1, A1, U2, A2], 30);
    const remote = session([U1, A1, msg('srv-a-12', 'assistant', 12, { content: 'u2' }), MIRRORED_A2], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  it('does not match a non-mirrored id on content alone', () => {
    const local = session([U1, A1, U2, A2], 30);
    const remote = session([U1, A1, msg('other-u', 'user', 12, { content: 'u2' }), MIRRORED_A2], 40);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
  });

  // Before: a server copy with no turns always replaced the local chat. But
  // "no turns + a delivery" is also what a chat looks like whose FIRST turn
  // created the routine and whose PUT failed — replacing it destroyed turns
  // that existed only in this browser. It cannot be told apart from a clear
  // on another device followed by a delivery; the turns win, since an undone
  // clear can be repeated and lost turns cannot be recovered.
  it('keeps local turns the server never received when its copy holds only a delivery', () => {
    const local = { ...session([U1, A1], 30), title: 'Routines' };
    const remote = { ...session([DELIVERY], 40), title: 'Neuer Chat' };

    const { session: result, pushLocal } = reconcileNewerRemote(local, remote);

    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'p1']);
    expect(result.title).toBe('Routines');
    expect(result.updatedAt).toBe(30);
    expect(pushLocal).toBe(true);
  });

  it('takes the server copy when it holds no messages at all (a clear or reset)', () => {
    const local = session([U1, A1], 30);
    const remote = session([], 40);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(reconcileNewerRemote(local, remote)).toEqual({ session: remote, pushLocal: false });
    // Dropping local turns is never silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holds no messages'));
    warn.mockRestore();
  });
});

describe('hasNoTurns', () => {
  it('counts a chat holding only routine deliveries as empty', () => {
    expect(hasNoTurns([])).toBe(true);
    expect(hasNoTurns([DELIVERY])).toBe(true);
  });

  it('counts any real turn', () => {
    expect(hasNoTurns([DELIVERY, msg('u1', 'user', 20)])).toBe(false);
    expect(hasNoTurns([msg('a1', 'assistant', 10)])).toBe(false);
  });
});
