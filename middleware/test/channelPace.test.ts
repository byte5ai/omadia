// Spec 2042 §5.8 Pace, criterion 10: acknowledge long work once, follow up when
// the work outlives the channel's reply window, never a silent timeout.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PACE_PROFILE, paceAckText, runPacedTurn, type PaceClock } from '@omadia/channel-sdk';

/** A manual clock: timers fire only when the test advances time. */
function manualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { clock, advance };
}

describe('pace (criterion 10)', () => {
  it('a fast answer gets neither acknowledgement nor follow-up', async () => {
    const { clock } = manualClock();
    const acks: string[] = [];
    const out = await runPacedTurn(async () => 'ok', DEFAULT_PACE_PROFILE, { sendAck: (t) => void acks.push(t) }, { clock });
    assert.deepEqual(acks, []);
    assert.equal(out.acknowledged, false);
    assert.equal(out.deliverAsFollowUp, false);
  });

  it('acknowledges once after the threshold, in the agent locale, without a model', async () => {
    const { clock, advance } = manualClock();
    const acks: string[] = [];
    let release: (v: string) => void = () => undefined;
    const pending = runPacedTurn(
      () => new Promise<string>((r) => (release = r)),
      { ackThresholdMs: 5_000 },
      { sendAck: (t) => void acks.push(t) },
      { clock, locale: 'en' },
    );
    await advance(4_999);
    assert.deepEqual(acks, []);
    await advance(2);
    await advance(60_000);
    assert.deepEqual(acks, [paceAckText('en')], 'exactly one acknowledgement, no progress chatter');
    release('done');
    const out = await pending;
    assert.equal(out.acknowledged, true);
    assert.equal(out.result, 'done');
  });

  it('marks work that outlives the reply window as a follow-up', async () => {
    const { clock, advance } = manualClock();
    let release: (v: string) => void = () => undefined;
    const pending = runPacedTurn(
      () => new Promise<string>((r) => (release = r)),
      { ackThresholdMs: 3_000, replyWindowMs: 10_000 },
      { sendAck: () => undefined },
      { clock },
    );
    await advance(12_000);
    release('late');
    const out = await pending;
    assert.equal(out.deliverAsFollowUp, true);
  });

  it('keeps the typing indicator alive and never fails the turn on a hook error', async () => {
    const { clock, advance } = manualClock();
    let typing = 0;
    const errors: string[] = [];
    let release: (v: number) => void = () => undefined;
    const pending = runPacedTurn(
      () => new Promise<number>((r) => (release = r)),
      { ackThresholdMs: 100_000, typingIntervalMs: 4_000 },
      {
        sendTyping: () => {
          typing += 1;
        },
        sendAck: () => {
          throw new Error('boom');
        },
        onHookError: (hook) => errors.push(hook),
      },
      { clock },
    );
    await advance(9_000);
    assert.ok(typing >= 3, `typing sent ${String(typing)}x`);
    await advance(100_000);
    release(1);
    const out = await pending;
    assert.equal(out.result, 1);
    assert.deepEqual(errors, ['ack']);
  });

  it('rejects when the work rejects', async () => {
    const { clock } = manualClock();
    await assert.rejects(
      runPacedTurn(async () => {
        throw new Error('agent failed');
      }, DEFAULT_PACE_PROFILE, { sendAck: () => undefined }, { clock }),
      /agent failed/,
    );
  });
});
