/**
 * #1017 item 4 — the `foreign` flag on a `tool_use` event used to be dead
 * code: set by the subscription-CLI agent, read by nobody. These tests pin
 * the counter contract that replaced the silence.
 *
 * The expected value of every counter here is ZERO in a healthy system: a
 * foreign call means the OM-81 spawn gate did not hold. That is why the
 * module alerts on every occurrence instead of once per episode.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  getForeignToolMetrics,
  recordForeignToolCall,
  resetForeignToolMetrics,
} from '../src/platform/foreignToolMetrics.js';

describe('foreignToolMetrics (#1017)', () => {
  afterEach(() => {
    resetForeignToolMetrics();
  });

  it('starts at zero with no timestamps, so "nothing leaked" is distinguishable from "never ran"', () => {
    const m = getForeignToolMetrics();
    assert.equal(m.calls, 0);
    assert.deepEqual(m.byTool, {});
    assert.deepEqual(m.byAgent, {});
    assert.equal(m.firstSeenAt, undefined);
    assert.equal(m.lastSeenAt, undefined);
  });

  it('counts a call per tool and per agent so the leaking built-in is identifiable', () => {
    const alerts: string[] = [];
    const onAlert = (tool: string): void => void alerts.push(tool);

    recordForeignToolCall('Bash', 'fallback', onAlert);
    recordForeignToolCall('Bash', 'fallback', onAlert);
    recordForeignToolCall('Read', 'other', onAlert);

    const m = getForeignToolMetrics();
    assert.equal(m.calls, 3);
    assert.deepEqual(m.byTool, { Bash: 2, Read: 1 });
    assert.deepEqual(m.byAgent, { fallback: 2, other: 1 });
    // Every occurrence alerts. A gate failure has no benign steady state to
    // suppress, unlike the broker's denial streaks.
    assert.deepEqual(alerts, ['Bash', 'Bash', 'Read']);
  });

  it('stamps first and last occurrence', () => {
    const noop = (): void => {};
    recordForeignToolCall('Bash', 'fallback', noop);
    const m = getForeignToolMetrics();
    assert.equal(typeof m.firstSeenAt, 'number');
    assert.equal(typeof m.lastSeenAt, 'number');
    assert.ok((m.lastSeenAt ?? 0) >= (m.firstSeenAt ?? 0));
  });

  it('never throws when the alert sink throws — evidence must not break the turn', () => {
    assert.doesNotThrow(() => {
      recordForeignToolCall('Bash', 'fallback', () => {
        throw new Error('sink exploded');
      });
    });
    // The counter still moved: the increment happens before the alert.
    assert.equal(getForeignToolMetrics().calls, 1);
  });

  it('hands out an immutable snapshot', () => {
    const noop = (): void => {};
    recordForeignToolCall('Bash', 'fallback', noop);
    const m = getForeignToolMetrics();
    (m.byTool as Record<string, number>)['Bash'] = 999;
    assert.equal(getForeignToolMetrics().byTool['Bash'], 1);
  });
});
