import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { BuilderTurnRingBuffer } from '../../src/plugins/builder/turnRingBuffer.js';
import type { BuilderEvent } from '../../src/plugins/builder/builderAgent.js';

const turnDoneEv: BuilderEvent = { type: 'turn_done', turnId: 't1' };
const userMsgEv: BuilderEvent = {
  type: 'chat_message',
  role: 'user',
  text: 'hi',
};
const assistantMsgEv: BuilderEvent = {
  type: 'chat_message',
  role: 'assistant',
  text: 'ok',
};

describe('BuilderTurnRingBuffer', () => {
  it('assigns monotonic ids starting at 1', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    const a = rb.record('t1', userMsgEv);
    const b = rb.record('t1', assistantMsgEv);
    const c = rb.record('t1', turnDoneEv);
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(c.id, 3);
  });

  it('start is idempotent for the same turnId', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.record('t1', userMsgEv); // id 1
    rb.start('t1'); // no-op — should not reset
    const next = rb.record('t1', assistantMsgEv);
    assert.equal(next.id, 2);
  });

  it('record throws when the turn was never started', () => {
    const rb = new BuilderTurnRingBuffer();
    assert.throws(() => rb.record('unknown', userMsgEv), /unknown turn/);
  });

  it('record throws when the turn was already finalised', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.finalize('t1');
    assert.throws(() => rb.record('t1', userMsgEv), /already finalised/);
  });

  it('snapshot since=0 returns all frames in order', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.record('t1', userMsgEv);
    rb.record('t1', assistantMsgEv);
    const out = rb.snapshot('t1');
    assert.ok(out);
    assert.equal(out?.length, 2);
    assert.equal(out?.[0]?.id, 1);
    assert.equal(out?.[1]?.id, 2);
  });

  it('snapshot since=N returns only frames after N', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.record('t1', userMsgEv);
    rb.record('t1', assistantMsgEv);
    rb.record('t1', turnDoneEv);
    const out = rb.snapshot('t1', 1);
    assert.equal(out?.length, 2);
    assert.equal(out?.[0]?.id, 2);
    assert.equal(out?.[1]?.id, 3);
  });

  it('snapshot returns null for unknown turn', () => {
    const rb = new BuilderTurnRingBuffer();
    assert.equal(rb.snapshot('nope'), null);
  });

  it('isFinal returns null|false|true correctly', () => {
    const rb = new BuilderTurnRingBuffer();
    assert.equal(rb.isFinal('nope'), null);
    rb.start('t1');
    assert.equal(rb.isFinal('t1'), false);
    rb.finalize('t1');
    assert.equal(rb.isFinal('t1'), true);
  });

  it('caps the buffer at maxEventsPerTurn (oldest dropped first)', () => {
    const rb = new BuilderTurnRingBuffer({ maxEventsPerTurn: 3 });
    rb.start('t1');
    rb.record('t1', userMsgEv); // 1
    rb.record('t1', assistantMsgEv); // 2
    rb.record('t1', userMsgEv); // 3
    rb.record('t1', assistantMsgEv); // 4 — pushes 1 out
    const out = rb.snapshot('t1');
    assert.equal(out?.length, 3);
    assert.equal(out?.[0]?.id, 2);
    assert.equal(out?.[2]?.id, 4);
  });

  it('GCs finalised turns after gcAfterMs (custom timer hook)', () => {
    let scheduled: { fn: () => void; delay: number } | null = null;
    const fakeTimer = { unref(): void {} };
    const rb = new BuilderTurnRingBuffer({
      gcAfterMs: 100,
      setTimer: (fn, delayMs) => {
        scheduled = { fn, delay: delayMs };
        return fakeTimer;
      },
      clearTimer: () => {},
    });
    rb.start('t1');
    rb.record('t1', userMsgEv);
    rb.finalize('t1');
    assert.ok(rb.hasTurn('t1'));
    assert.equal(scheduled !== null, true);
    assert.equal(scheduled !== null && (scheduled as { delay: number }).delay, 100);
    // Fire the scheduled GC timer manually
    if (scheduled !== null) (scheduled as { fn: () => void }).fn();
    assert.equal(rb.hasTurn('t1'), false);
  });

  it('subscribe forwards live frames and onFinal on finalize', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.record('t1', userMsgEv); // id 1 — already buffered before subscribe
    const seen: number[] = [];
    let finalCalled = 0;
    rb.subscribe(
      't1',
      (f) => seen.push(f.id),
      () => {
        finalCalled += 1;
      },
    );
    rb.record('t1', assistantMsgEv); // id 2
    rb.record('t1', turnDoneEv); // id 3
    rb.finalize('t1');
    assert.deepEqual(seen, [2, 3]);
    assert.equal(finalCalled, 1);
  });

  it('subscribe to an already-final turn calls onFinal synchronously', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.finalize('t1');
    let calls = 0;
    const unsubscribe = rb.subscribe(
      't1',
      () => {
        calls += 1;
      },
      () => {
        calls += 100;
      },
    );
    assert.equal(calls, 100);
    // unsubscribe should be a no-op now
    unsubscribe();
  });

  it('subscribe to an unknown turn calls onFinal synchronously', () => {
    const rb = new BuilderTurnRingBuffer();
    let calls = 0;
    rb.subscribe(
      'nope',
      () => {
        calls += 1;
      },
      () => {
        calls += 100;
      },
    );
    assert.equal(calls, 100);
  });

  it('unsubscribe removes the listener', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    let frames = 0;
    const off = rb.subscribe(
      't1',
      () => {
        frames += 1;
      },
      () => {},
    );
    rb.record('t1', userMsgEv);
    off();
    rb.record('t1', assistantMsgEv);
    assert.equal(frames, 1);
  });

  it('forget drops the turn buffer regardless of state', () => {
    const rb = new BuilderTurnRingBuffer();
    rb.start('t1');
    rb.record('t1', userMsgEv);
    rb.forget('t1');
    assert.equal(rb.hasTurn('t1'), false);
    assert.equal(rb.snapshot('t1'), null);
  });

  it('activeTurnCount tracks Map size', () => {
    const rb = new BuilderTurnRingBuffer();
    assert.equal(rb.activeTurnCount(), 0);
    rb.start('t1');
    rb.start('t2');
    assert.equal(rb.activeTurnCount(), 2);
    rb.forget('t1');
    assert.equal(rb.activeTurnCount(), 1);
  });
});
