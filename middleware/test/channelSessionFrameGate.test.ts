/**
 * The per-frame session gate of `ChannelSessionTracker`, on a fake socket with
 * mocked timers. Revocation announcements are process-local, so this gate is
 * what carries a revocation made on another replica to an open socket:
 *
 *   - a frame reaches the handler only on a verdict whose check started at
 *     most `frameRecheckMs` (default WS_SESSION_FRAME_RECHECK_MS, 5 s) before
 *     the frame arrived — the upgrade's own check counts. With an older one
 *     the frame waits for a new check, and so does everything behind it, in
 *     order, while the socket stops reading (backpressure);
 *   - a refusal closes the socket and drops what was waiting;
 *   - an outage (a lookup that fails, throws or misses its deadline) keeps the
 *     socket but withholds the waiting frames from `onMessage` — they go to
 *     `onRefusedMessage` — and ends the grace of the verdict before it, so
 *     the next frame checks again; a refusal that lands after the deadline
 *     still closes;
 *   - a revocation announced while the upgrade was being checked closes the
 *     socket at `accept`, before any handler sees it — and so does (1013) a
 *     flood of announcements too long to rule this user's revocation out;
 *   - how old a verdict is and when a frame arrived are read from a monotonic
 *     clock, so stepping the wall clock back cannot stretch a verdict.
 */

import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { WebSocket } from 'ws';

import type { SessionEvaluation } from '../src/auth/requireAuth.js';
import type { RevocationListener } from '../src/auth/sessionRevocation.js';
import {
  ChannelSessionTracker,
  RECENT_REVOCATIONS_KEPT,
  WS_CLOSE_TRY_AGAIN,
  WS_SESSION_CHECK_TIMEOUT_MS,
  WS_SESSION_FRAME_RECHECK_MS,
  type ChannelSessionTrackerDeps,
  type UpgradeMark,
} from '../src/channels/channelSessionLifetime.js';
import {
  FakeWs,
  MonotonicClock,
  NOW_MS,
  NOW_S,
  OK,
  REQ,
  REVOKED,
  UNAVAILABLE,
  deferred,
  session,
  settle,
} from './_helpers/channelSessionFakes.js';

const EXP = NOW_S + 4 * 3600;
/** Far beyond every window these tests watch: the sweep never interferes. */
const NO_SWEEP_MS = 3_600_000;

/** Verdicts handed out in order, one per check; the last one repeats. */
function verdicts(...queue: Array<SessionEvaluation | Promise<SessionEvaluation>>): {
  evaluate: (token: string) => Promise<SessionEvaluation>;
  checks: () => number;
} {
  let n = 0;
  return {
    evaluate: () => {
      const next = queue[Math.min(n, queue.length - 1)] as SessionEvaluation | Promise<SessionEvaluation>;
      n += 1;
      return Promise.resolve(next);
    },
    checks: () => n,
  };
}

let clock: MonotonicClock;

function tracker(deps: Partial<ChannelSessionTrackerDeps>): ChannelSessionTracker {
  return new ChannelSessionTracker({
    evaluate: () => Promise.resolve(OK),
    recheckMs: NO_SWEEP_MS,
    monotonicNow: clock.now,
    ...deps,
  });
}

interface Opened {
  ws: FakeWs;
  seen: string[];
  refused: string[];
}

function open(t: ChannelSessionTracker, mark?: UpgradeMark, sub = 'u1'): Opened {
  const ws = new FakeWs();
  const seen: string[] = [];
  const refused: string[] = [];
  const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(EXP, sub), mark);
  socket?.onMessage((m) => seen.push(m));
  socket?.onRefusedMessage?.((m) => refused.push(m));
  return { ws, seen, refused };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW_MS });
  clock = new MonotonicClock();
});

afterEach(() => {
  mock.timers.reset();
});

describe('ChannelSessionTracker — every frame rides on a recent verdict', () => {
  it('defaults: a verdict serves frames for 5 s, a check gives up after 10 s', () => {
    assert.equal(WS_SESSION_FRAME_RECHECK_MS, 5_000);
    assert.equal(WS_SESSION_CHECK_TIMEOUT_MS, 10_000);
  });

  it('a frame within 5 s of the upgrade check is delivered at once, without a check', () => {
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate });
    const mark = t.mark();
    clock.tick(1_000); // the upgrade check took a second
    const { ws, seen } = open(t, mark);
    clock.tick(3_999);
    ws.frame('a');
    assert.deepEqual(seen, ['a']);
    assert.equal(v.checks(), 0);
  });

  it('a frame past the bound waits for a new check; one check serves the whole burst, in order', async () => {
    const pending = deferred<SessionEvaluation>();
    const v = verdicts(pending.promise);
    const t = tracker({ evaluate: v.evaluate });
    const { ws, seen } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a');
    ws.frame('b');
    ws.frame('c');
    await settle();
    assert.deepEqual(seen, [], 'nothing is delivered before the verdict');
    assert.equal(v.checks(), 1);
    assert.equal(ws.isPaused, true, 'no reading while frames wait: TCP backpressure');

    pending.resolve(OK);
    await settle();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(ws.isPaused, false);
    // The new verdict serves the next frame directly.
    ws.frame('d');
    assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
    assert.equal(v.checks(), 1);
  });

  it('a revoked verdict closes with 4403 and drops every frame that waited on it', async () => {
    const pending = deferred<SessionEvaluation>();
    const t = tracker({ evaluate: verdicts(pending.promise).evaluate });
    const { ws, seen, refused } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a');
    ws.frame('b');
    pending.resolve(REVOKED);
    await settle();
    assert.deepEqual(ws.closedWith, { code: 4403, reason: 'session revoked' });
    assert.equal(ws.isPaused, false, 'reading again, so the close handshake can finish');
    ws.frame('c');
    await settle();
    assert.deepEqual(seen, []);
    assert.deepEqual(refused, [], 'a refusal is a close, not a withheld frame');
  });

  it('with a bound of 0 every frame waits for a check started after it arrived', async () => {
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate, frameRecheckMs: 0 });
    const { ws, seen } = open(t, t.mark());
    clock.tick(1);
    ws.frame('a');
    await settle();
    clock.tick(1);
    ws.frame('b');
    await settle();
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(v.checks(), 2);
  });

  it('a handler that throws does not stop the frames behind it', async () => {
    const t = tracker({});
    const ws = new FakeWs();
    const seen: string[] = [];
    const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(EXP), t.mark());
    socket?.onMessage((m) => {
      if (m === 'boom') throw new Error('handler bug');
      seen.push(m);
    });
    ws.frame('boom');
    ws.frame('after');
    await settle();
    assert.deepEqual(seen, ['after']);
    assert.equal(ws.closedWith, undefined);
  });
});

describe('ChannelSessionTracker — no verdict, no frame', () => {
  it('an outage withholds the waiting frames, keeps the socket, and the next frame checks again', async () => {
    const v = verdicts(UNAVAILABLE, OK);
    const t = tracker({ evaluate: v.evaluate });
    const { ws, seen, refused } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a');
    ws.frame('b');
    await settle();
    assert.deepEqual(seen, []);
    assert.deepEqual(refused, ['a', 'b']);
    assert.equal(ws.closedWith, undefined, 'an outage is not a verdict on the session');

    ws.frame('c');
    await settle();
    assert.deepEqual(seen, ['c']);
    assert.equal(v.checks(), 2);
  });

  it('a check that throws counts as an outage', async () => {
    const t = tracker({
      evaluate: () => {
        throw new Error('pool exhausted');
      },
    });
    const { ws, seen, refused } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a');
    await settle();
    assert.deepEqual([seen, refused], [[], ['a']]);
    assert.equal(ws.closedWith, undefined);
  });

  it('a check past its deadline withholds the frame; the next frame checks anew; a late refusal still closes', async () => {
    const hung = deferred<SessionEvaluation>();
    const v = verdicts(hung.promise, OK);
    const t = tracker({ evaluate: v.evaluate, checkTimeoutMs: 1_000 });
    const { ws, seen, refused } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a');
    await settle();
    clock.tick(999);
    await settle();
    assert.deepEqual(refused, [], 'still inside the deadline');
    clock.tick(1);
    await settle();
    assert.deepEqual(refused, ['a']);
    assert.equal(ws.closedWith, undefined);

    ws.frame('b');
    await settle();
    assert.deepEqual(seen, ['b'], 'the hung check is not waited for again');
    assert.equal(v.checks(), 2);

    hung.resolve(REVOKED);
    await settle();
    assert.deepEqual(ws.closedWith, { code: 4403, reason: 'session revoked' });
  });

  it('an outage on the sweep ends the grace of the verdict before it', async () => {
    const v = verdicts(OK, UNAVAILABLE, OK);
    const t = tracker({ evaluate: v.evaluate, recheckMs: 60_000 });
    const { ws, seen } = open(t, t.mark());
    clock.tick(59_000);
    ws.frame('a'); // stale against the upgrade: check #1, ok
    await settle();
    clock.tick(1_000); // the sweep: check #2, unavailable
    await settle();
    clock.tick(1_000); // 2 s after the ok verdict, 1 s after the outage
    ws.frame('b'); // must not ride on the ok from before the outage: check #3
    await settle();
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(v.checks(), 3);
  });
});

describe('ChannelSessionTracker — the upgrade window', () => {
  function announcer(): {
    revocations: ChannelSessionTrackerDeps['revocations'];
    announce: (sub: string) => void;
  } {
    const listeners: RevocationListener[] = [];
    return {
      revocations: {
        onRevoked: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
      },
      announce: (sub) => {
        for (const listener of listeners) listener({ provider: 'local', sub });
      },
    };
  }

  it('a revocation of this user announced during the upgrade check closes at accept', () => {
    const a = announcer();
    const t = tracker({ revocations: a.revocations });
    const mark = t.mark();
    a.announce('u1'); // the upgrade's read already found the row current
    const ws = new FakeWs();
    const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(EXP, 'u1'), mark);
    assert.equal(socket, undefined, 'no socket is handed to the handler');
    assert.deepEqual(ws.closedWith, { code: 4403, reason: 'session revoked' });
  });

  it('a revocation of another user in that window leaves the socket alone', () => {
    const a = announcer();
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate, revocations: a.revocations });
    const mark = t.mark();
    a.announce('u2');
    const { ws, seen } = open(t, mark, 'u1');
    ws.frame('a');
    assert.deepEqual(seen, ['a']);
    assert.equal(ws.closedWith, undefined);
    assert.equal(v.checks(), 0);
  });

  it('when more announcements arrived than are kept, it closes with 1013 before any handler sees it', () => {
    const a = announcer();
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate, revocations: a.revocations });
    const mark = t.mark();
    for (let i = 0; i <= RECENT_REVOCATIONS_KEPT; i += 1) a.announce(`other-${String(i)}`);
    const ws = new FakeWs();
    const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(EXP, 'u1'), mark);
    // u1's own revocation may have been among those dropped from the log, so
    // the upgrade verdict is worth nothing — not even until a first frame: a
    // handler's connection-time work and its pushes need no frame.
    assert.equal(socket, undefined, 'no socket is handed to the handler');
    assert.deepEqual(ws.closedWith, { code: WS_CLOSE_TRY_AGAIN, reason: 'session unverified' });
    assert.equal(v.checks(), 0, 'the reconnect gets checked, not this socket');
    assert.equal(t.closeSessions(() => true), 0, 'nothing is left behind');
  });

  it('as many announcements as are kept, none of them this user\'s: the socket is handed over', () => {
    const a = announcer();
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate, revocations: a.revocations });
    const mark = t.mark();
    for (let i = 0; i < RECENT_REVOCATIONS_KEPT; i += 1) a.announce(`other-${String(i)}`);
    const { ws, seen } = open(t, mark, 'u1');
    ws.frame('a');
    assert.deepEqual(seen, ['a']);
    assert.equal(ws.closedWith, undefined);
    assert.equal(v.checks(), 0);
  });
});

describe('ChannelSessionTracker — ages run on a monotonic clock', () => {
  it('a wall clock stepped back does not let a frame ride on a verdict past the bound', async () => {
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate });
    const { ws, seen } = open(t, t.mark());
    clock.tick(5_001); // the upgrade verdict is now too old for a frame
    mock.timers.setTime(NOW_MS - 3_600_000); // the wall clock steps back an hour
    ws.frame('a');
    await settle();
    assert.deepEqual(seen, ['a']);
    assert.equal(v.checks(), 1, 'the frame waited for a fresh check');
  });

  it('a verdict from before the step serves no longer than the bound after it', async () => {
    const v = verdicts(OK);
    const t = tracker({ evaluate: v.evaluate });
    const { ws, seen } = open(t, t.mark());
    clock.tick(5_001);
    ws.frame('a'); // check #1
    await settle();
    mock.timers.setTime(NOW_MS - 3_600_000); // the wall clock steps back an hour
    clock.tick(4_999);
    ws.frame('b'); // still within the bound of check #1
    clock.tick(2);
    ws.frame('c'); // past it, whatever the wall clock says
    await settle();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(v.checks(), 2);
  });

  it('defaults to performance.now, never to the wall clock', async (t) => {
    let monotonic = 0;
    t.mock.method(performance, 'now', () => monotonic);
    const v = verdicts(OK);
    // No `monotonicNow`: the production default.
    const tr = new ChannelSessionTracker({ evaluate: v.evaluate, recheckMs: NO_SWEEP_MS });
    const { ws, seen } = open(tr, tr.mark());
    monotonic += 5_001;
    mock.timers.setTime(NOW_MS - 3_600_000);
    ws.frame('a');
    await settle();
    assert.deepEqual(seen, ['a']);
    assert.equal(v.checks(), 1);
  });
});
