/**
 * The reminder waits for the page, through the real gate wiring (OM-71).
 *
 * Uses the production gate with injected timers, so a partial revert (calling
 * `remind()` straight after `loadApp()`, or arming after the load) goes red.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { showAppPage } from '../src/appPageBoot.ts';
import { createUiReadyGate, type GateTimers } from '../src/uiReadyGate.ts';

function fakeTimers(): GateTimers & { fire(): void } {
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
  };
}

interface Trace {
  readonly events: string[];
  loadApp(): Promise<void>;
  onLoaded(): void;
  remind(): Promise<void>;
}

function trace(): Trace {
  const events: string[] = [];
  return {
    events,
    loadApp: async () => {
      events.push('loadApp');
    },
    onLoaded: () => {
      events.push('onLoaded');
    },
    remind: async () => {
      events.push('remind');
    },
  };
}

/** Let the sequence advance to its `await ready`. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('showAppPage (OM-71)', () => {
  it('does not remind before the UI pings, and does right after', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const t = trace();
    const run = showAppPage({ gate, ...t });
    await settle();
    assert.deepEqual(t.events, ['loadApp', 'onLoaded'], 'loaded, but no reminder yet');

    gate.signal();
    assert.equal(await run, 'signal');
    assert.deepEqual(t.events, ['loadApp', 'onLoaded', 'remind']);
  });

  it('still reminds when the UI never pings (fallback)', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const t = trace();
    const run = showAppPage({ gate, ...t });
    await settle();
    timers.fire();
    assert.equal(await run, 'fallback');
    assert.deepEqual(t.events, ['loadApp', 'onLoaded', 'remind']);
  });

  it('a ping that lands during loadApp is not lost (gate is armed first)', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const t = trace();
    const run = showAppPage({
      gate,
      onLoaded: t.onLoaded,
      remind: t.remind,
      loadApp: async () => {
        t.events.push('loadApp');
        // A very fast renderer: pings before loadURL even resolves.
        gate.signal();
      },
    });
    assert.equal(await run, 'signal');
    assert.deepEqual(t.events, ['loadApp', 'onLoaded', 'remind']);
  });

  it('a restart that supersedes the boot hands the reminder to the newer page', async () => {
    const timers = fakeTimers();
    const gate = createUiReadyGate(10_000, timers);
    const first = trace();
    const second = trace();
    const bootRun = showAppPage({ gate, ...first });
    await settle();
    const restartRun = showAppPage({ gate, ...second });
    await settle();
    assert.equal(await bootRun, 'superseded');
    assert.deepEqual(first.events, ['loadApp', 'onLoaded'], 'the superseded boot must not remind');

    gate.signal();
    assert.equal(await restartRun, 'signal');
    assert.deepEqual(second.events, ['loadApp', 'onLoaded', 'remind']);
  });
});
