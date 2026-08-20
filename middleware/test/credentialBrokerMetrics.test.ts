/**
 * #578 Phase 2 — `brokerMetrics.ts`, built the same shape as
 * `securityScreenMetrics.ts` (#749). Same tests in spirit: counters must
 * move on every outcome, the streak alert must fire once per episode (not
 * once per denial), and a single allow must end the episode.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  BROKER_DENIAL_STREAK_ALERT,
  getBrokerMetrics,
  recordBrokerOutcome,
  resetBrokerMetrics,
} from '../src/credentials/brokerMetrics.js';

describe('#578 brokerMetrics', () => {
  beforeEach(() => {
    resetBrokerMetrics();
  });

  it('starts at zero with a 0 deniedRate, not NaN', () => {
    const m = getBrokerMetrics();
    assert.equal(m.requests, 0);
    assert.equal(m.deniedRate, 0);
  });

  it('counts an allow', () => {
    recordBrokerOutcome('allow');
    const m = getBrokerMetrics();
    assert.equal(m.requests, 1);
    assert.equal(m.allowed, 1);
    assert.equal(m.denied, 0);
  });

  it('counts a deny by reason', () => {
    recordBrokerOutcome('deny', 'host-not-allowed');
    recordBrokerOutcome('deny', 'host-not-allowed');
    recordBrokerOutcome('deny', 'no-active-grant');
    const m = getBrokerMetrics();
    assert.equal(m.denied, 3);
    assert.equal(m.byReason['host-not-allowed'], 2);
    assert.equal(m.byReason['no-active-grant'], 1);
    assert.equal(m.byReason['method-not-allowed'], 0, 'every reason must be present, even at zero');
  });

  it('computes deniedRate over total requests', () => {
    recordBrokerOutcome('allow');
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('deny', 'no-active-grant');
    assert.equal(getBrokerMetrics().deniedRate, 0.75);
  });

  it('tracks a consecutive-denial streak and resets it on an allow', () => {
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('deny', 'no-active-grant');
    assert.equal(getBrokerMetrics().consecutiveDenied, 2);
    recordBrokerOutcome('allow');
    assert.equal(getBrokerMetrics().consecutiveDenied, 0);
  });

  it('remembers the WORST streak even after it ends', () => {
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('deny', 'no-active-grant');
    recordBrokerOutcome('allow');
    recordBrokerOutcome('deny', 'no-active-grant');
    const m = getBrokerMetrics();
    assert.equal(m.consecutiveDenied, 1);
    assert.equal(m.worstConsecutiveDenied, 3);
  });

  it('fires the alert exactly once per streak, at the threshold', () => {
    let alerts = 0;
    for (let i = 0; i < BROKER_DENIAL_STREAK_ALERT + 3; i += 1) {
      recordBrokerOutcome('deny', 'store-unavailable', () => {
        alerts += 1;
      });
    }
    assert.equal(alerts, 1, 'must not re-alert on every denial past the threshold');
  });

  it('re-arms the alert after an allow breaks the streak', () => {
    let alerts = 0;
    const onAlert = () => {
      alerts += 1;
    };
    for (let i = 0; i < BROKER_DENIAL_STREAK_ALERT; i += 1) recordBrokerOutcome('deny', 'store-unavailable', onAlert);
    assert.equal(alerts, 1);
    recordBrokerOutcome('allow');
    for (let i = 0; i < BROKER_DENIAL_STREAK_ALERT; i += 1) recordBrokerOutcome('deny', 'store-unavailable', onAlert);
    assert.equal(alerts, 2, 'a fresh streak after a break deserves its own alert');
  });

  it('never throws, even if the alert callback throws', () => {
    assert.doesNotThrow(() => {
      recordBrokerOutcome('deny', 'store-unavailable', () => {
        throw new Error('boom');
      });
    });
  });
});
