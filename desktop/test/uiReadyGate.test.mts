/**
 * The recovery-key reminder waits for the page, not for the navigation (OM-71).
 *
 * `win.loadURL()` resolves when the document has loaded, which for the web UI
 * is the moment it shows "Loading login…" and starts hydrating. The reminder
 * used to fire right there, over a page that was not yet standing. The gate
 * below waits for the UI's own ready ping, with a bounded fallback so a web UI
 * that never pings (an older build, a crashed renderer) still gets its reminder.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createUiReadyGate, type GateTimers } from '../src/uiReadyGate.ts';

interface FakeTimers extends GateTimers {
  fire(): void;
  readonly pending: number;
}

function fakeTimers(): FakeTimers {
  const handles = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (fn) => {
      const id = next++;
      handles.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      handles.delete(id as number);
    },
    fire() {
      for (const [id, fn] of [...handles]) {
        handles.delete(id);
        fn();
      }
    },
    get pending() {
      return handles.size;
    },
  };
}

describe('uiReadyGate (OM-71)', () => {
  it('resolves with "signal" when the UI pings after arming', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const armed = gate.arm();
    gate.signal();
    assert.equal(await armed, 'signal');
    assert.equal(timers.pending, 0, 'the fallback timer is cleared after the ping');
  });

  it('resolves with "fallback" when the UI never pings', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const armed = gate.arm();
    timers.fire();
    assert.equal(await armed, 'fallback');
  });

  it('ignores a ping that arrives before arming (stale renderer)', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    gate.signal();
    const armed = gate.arm();
    let settled = false;
    void armed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, 'a stale ping must not satisfy a later arm');
    gate.signal();
    assert.equal(await armed, 'signal');
  });

  it('a second arm supersedes the first (a restart replaced the page)', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const first = gate.arm();
    const second = gate.arm();
    assert.equal(await first, 'superseded');
    assert.equal(timers.pending, 1, 'only the live arm keeps a fallback timer');
    gate.signal();
    assert.equal(await second, 'signal');
  });

  it('a ping after the fallback fired is ignored', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const armed = gate.arm();
    timers.fire();
    assert.equal(await armed, 'fallback');
    // Must not throw or resolve anything a second time.
    gate.signal();
  });
});
