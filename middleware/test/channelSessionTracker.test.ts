/**
 * `ChannelSessionTracker` on a fake socket and mocked timers — the timing
 * edges a real socket cannot pin down deterministically:
 *
 *   - the expiry close lands at `exp` exactly, not a millisecond earlier;
 *   - a frame that arrives after `exp` while the expiry timer is late is
 *     dropped and the socket closed right there;
 *   - an `exp` beyond setTimeout's ~24.8-day ceiling is re-armed, not fired
 *     early;
 *   - a session without `exp` is closed at accept and no socket is handed out;
 *   - re-check verdicts map to close codes, an outage keeps the socket, and a
 *     slow check is never started twice.
 *
 * The per-frame gate lives in `channelSessionFrameGate.test.ts`, the
 * real-socket behaviour in `webSocketRegistrySession.test.ts` and
 * `webSocketRegistryFrameGate.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { WebSocket } from 'ws';

import type { SessionEvaluation } from '../src/auth/requireAuth.js';
import { ChannelSessionTracker } from '../src/channels/channelSessionLifetime.js';
import {
  FakeWs,
  NOW_MS,
  NOW_S,
  OK,
  REQ,
  session,
  settle,
} from './_helpers/channelSessionFakes.js';

const HOUR_MS = 3_600_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

function tracker(
  evaluate: (token: string) => Promise<SessionEvaluation> = () => Promise.resolve(OK),
  recheckMs = HOUR_MS,
  checkTimeoutMs?: number,
): ChannelSessionTracker {
  return new ChannelSessionTracker({
    evaluate,
    recheckMs,
    ...(checkTimeoutMs !== undefined ? { checkTimeoutMs } : {}),
  });
}

function accept(t: ChannelSessionTracker, expiresAt: number, seen: string[] = []): FakeWs {
  const ws = new FakeWs();
  const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(expiresAt));
  socket?.onMessage((m) => seen.push(m));
  return ws;
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW_MS });
});

afterEach(() => {
  mock.timers.reset();
});

describe('ChannelSessionTracker — expiry', () => {
  it('closes with 4401 at exp exactly, not a millisecond earlier', () => {
    const ws = accept(tracker(), NOW_S + 10);
    mock.timers.tick(9_999);
    assert.equal(ws.closedWith, undefined, 'still inside the session');
    mock.timers.tick(1);
    assert.deepEqual(ws.closedWith, { code: 4401, reason: 'session expired' });
  });

  it('drops a frame that arrives after exp while the expiry timer is late, and closes', () => {
    const seen: string[] = [];
    const ws = accept(tracker(), NOW_S + 10, seen);
    ws.emit('message', Buffer.from('in time'), false);
    // The wall clock passes exp, but the expiry timer has not run yet.
    mock.timers.setTime(NOW_MS + 10_000);
    ws.emit('message', Buffer.from('too late'), false);
    assert.deepEqual(seen, ['in time']);
    assert.deepEqual(ws.closedWith, { code: 4401, reason: 'session expired' });
  });

  it('re-arms past the setTimeout ceiling instead of firing early', () => {
    const expiresAt = NOW_S + 30 * 24 * 3600; // 30 days > ~24.8-day ceiling
    const ws = accept(tracker(() => Promise.resolve(OK), MAX_TIMER_MS), expiresAt);
    mock.timers.tick(MAX_TIMER_MS);
    assert.equal(ws.closedWith, undefined, 'the ceiling is not the expiry');
    mock.timers.tick(expiresAt * 1000 - NOW_MS - MAX_TIMER_MS - 1);
    assert.equal(ws.closedWith, undefined);
    mock.timers.tick(1);
    assert.deepEqual(ws.closedWith, { code: 4401, reason: 'session expired' });
  });

  it('a session without exp is closed at accept and no socket is handed out', () => {
    const t = tracker();
    const ws = new FakeWs();
    const socket = t.accept(ws as unknown as WebSocket, REQ, 'ch', session(0));
    assert.equal(socket, undefined);
    assert.deepEqual(ws.closedWith, { code: 4401, reason: 'session expired' });
  });

  it('a socket that closes before exp leaves no expiry close behind', () => {
    const t = tracker();
    const ws = accept(t, NOW_S + 10);
    ws.close(1000, 'client done');
    ws.finishClose();
    mock.timers.tick(20_000);
    assert.deepEqual(ws.closedWith, { code: 1000, reason: 'client done' });
    assert.equal(t.closeSessions(() => true), 0);
  });
});

describe('ChannelSessionTracker — periodic re-check', () => {
  const RECHECK_MS = 60_000;

  async function afterRecheck(verdict: SessionEvaluation, expiresAt = NOW_S + 4 * 3600): Promise<FakeWs> {
    const ws = accept(tracker(() => Promise.resolve(verdict), RECHECK_MS), expiresAt);
    mock.timers.tick(RECHECK_MS);
    await settle();
    return ws;
  }

  it('maps a revoked session to 4403 "session revoked"', async () => {
    const ws = await afterRecheck({ ok: false, code: 'auth.revoked', message: 'x' });
    assert.deepEqual(ws.closedWith, { code: 4403, reason: 'session revoked' });
  });

  it('maps a de-whitelisted identity to 4403 "session forbidden"', async () => {
    const ws = await afterRecheck({ ok: false, code: 'auth.not_whitelisted', message: 'x' });
    assert.deepEqual(ws.closedWith, { code: 4403, reason: 'session forbidden' });
  });

  it('maps a token that no longer verifies to 4401 "session invalid"', async () => {
    const ws = await afterRecheck({ ok: false, code: 'auth.invalid', message: 'x' });
    assert.deepEqual(ws.closedWith, { code: 4401, reason: 'session invalid' });
  });

  it('keeps the socket on an outage — it is not a verdict', async () => {
    const ws = await afterRecheck({ ok: false, code: 'auth.unavailable', message: 'x' });
    assert.equal(ws.closedWith, undefined);
  });

  it('keeps a valid session open, re-checking it every interval', async () => {
    let checks = 0;
    const ws = accept(
      tracker(() => {
        checks += 1;
        return Promise.resolve(OK);
      }, RECHECK_MS),
      NOW_S + 4 * 3600,
    );
    for (let i = 0; i < 3; i += 1) {
      mock.timers.tick(RECHECK_MS);
      await settle();
    }
    assert.equal(checks, 3);
    assert.equal(ws.closedWith, undefined);
  });

  it('never starts a second check while one is still pending', async () => {
    let checks = 0;
    const ws = accept(
      // Deadline beyond the window watched here; the deadline itself is
      // covered in channelSessionFrameGate.test.ts.
      tracker(
        () => {
          checks += 1;
          return new Promise<SessionEvaluation>(() => undefined);
        },
        RECHECK_MS,
        10 * RECHECK_MS,
      ),
      NOW_S + 4 * 3600,
    );
    mock.timers.tick(RECHECK_MS);
    await settle();
    mock.timers.tick(RECHECK_MS);
    await settle();
    assert.equal(checks, 1);
    assert.equal(ws.closedWith, undefined);
  });
});
