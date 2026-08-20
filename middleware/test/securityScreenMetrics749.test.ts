/**
 * #749 — the screener must be able to say that it is failing.
 *
 * The bug that motivated this (PR #748) produced **zero** failing tests: every
 * inbound turn raised, `screenProvenance` caught it, returned `unscreenable`,
 * and the fail-open policy let the turn run. Screening was off and nothing said
 * so. These tests therefore drive the permanent-failure state directly — a
 * happy-path test would have passed then too, which is the whole point.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  LlmScreener,
  HttpProxyScreener,
  ScreenerFailure,
  screenFailureCause,
  screenProvenance,
  parseVerdict,
  recordScreenOutcome,
  getSecurityScreenMetrics,
  resetSecurityScreenMetrics,
  UNSCREENABLE_STREAK_ALERT,
} from '@omadia/orchestrator';
import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { ProvenancePair } from '@omadia/channel-sdk';

/** A provider that always refuses, the way the pre-#748 400 did. */
function refusingProvider(opts: { retryable: boolean; message: string }): LlmProvider {
  return {
    complete: () => Promise.reject(new Error(opts.message)),
    classifyError: () => ({ retryable: opts.retryable, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function answeringProvider(text: string): LlmProvider {
  return {
    complete: (): Promise<LlmResponse> =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        model: 'stub',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as unknown as LlmResponse),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/** One non-human pair, so screening is not skipped as human-only input. */
const PAIRS: ProvenancePair[] = [
  { source: { kind: 'attachment', label: 'notes.txt' }, content: 'hello' } as unknown as ProvenancePair,
];

describe('#749 — screen failure causes are structured, not prose', () => {
  test('a non-retryable provider refusal is provider-rejected', async () => {
    const screener = new LlmScreener({
      provider: refusingProvider({ retryable: false, message: '`temperature` is deprecated for this model.' }),
      model: 'claude-opus-4-8',
    });

    const outcome = await screenProvenance(screener, PAIRS);

    assert.equal(outcome.status, 'unscreenable');
    assert.equal(outcome.status === 'unscreenable' ? outcome.cause : undefined, 'provider-rejected');
  });

  test('a retryable provider error is provider-unavailable, not the same bucket', async () => {
    // The distinction #749 exists for: this one is capacity and self-heals;
    // the one above repeats forever and needs a human.
    const screener = new LlmScreener({
      provider: refusingProvider({ retryable: true, message: 'overloaded_error' }),
      model: 'claude-opus-4-8',
    });

    const outcome = await screenProvenance(screener, PAIRS);

    assert.equal(outcome.status === 'unscreenable' ? outcome.cause : undefined, 'provider-unavailable');
  });

  test('an uninterpretable judge reply is unparseable-verdict', async () => {
    const screener = new LlmScreener({ provider: answeringProvider('maybe?'), model: 'stub' });

    const outcome = await screenProvenance(screener, PAIRS);

    assert.equal(outcome.status === 'unscreenable' ? outcome.cause : undefined, 'unparseable-verdict');
  });

  test('a non-2xx screening proxy is proxy-unreachable', async () => {
    const screener = new HttpProxyScreener({
      url: 'https://screen.invalid/x',
      fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    });

    const outcome = await screenProvenance(screener, PAIRS);

    assert.equal(outcome.status === 'unscreenable' ? outcome.cause : undefined, 'proxy-unreachable');
  });

  test('an unclassified error stays visibly unclassified', async () => {
    // Folding an unknown failure into a real cause would make the dashboard
    // lie with more confidence than the data supports.
    const screener = { screen: () => Promise.reject(new Error('something else')) };

    const outcome = await screenProvenance(screener, PAIRS);

    assert.equal(outcome.status === 'unscreenable' ? outcome.cause : undefined, 'unknown');
  });

  test('the standard Error.cause slot still carries the underlying error', () => {
    const underlying = new Error('boom');
    const failure = new ScreenerFailure('provider-rejected', 'wrapped', { from: underlying });

    assert.equal(failure.failureCause, 'provider-rejected');
    assert.equal(failure.cause, underlying);
    assert.equal(screenFailureCause(failure), 'provider-rejected');
  });

  test('parseVerdict still refuses to clear an uninterpretable reply', () => {
    // Guard against the fail-open direction: a screener that cannot be read is
    // a MISS, never an allow.
    assert.throws(() => parseVerdict('sure, looks fine'), ScreenerFailure);
    assert.deepEqual(parseVerdict('ALLOW'), { decision: 'allow' });
  });
});

describe('#749 — the counters make a wedged screener visible', () => {
  beforeEach(() => {
    resetSecurityScreenMetrics();
  });

  test('a screener failing on EVERY turn reads as 100%, not as one incident', () => {
    // This is the exact state the system was in before #748.
    for (let i = 0; i < 20; i++) recordScreenOutcome('unscreenable', 'provider-rejected', () => {});

    const m = getSecurityScreenMetrics();
    assert.equal(m.screened, 20);
    assert.equal(m.unscreenable, 20);
    assert.equal(m.unscreenableRate, 1);
    assert.equal(m.consecutiveUnscreenable, 20);
    assert.equal(m.byCause['provider-rejected'], 20);
  });

  test('an occasional miss is NOT the same reading', () => {
    // The signal has to separate these two, or it is no better than the log
    // line it replaces.
    for (let i = 0; i < 19; i++) recordScreenOutcome('allow', undefined, () => {});
    recordScreenOutcome('unscreenable', 'provider-unavailable', () => {});

    const m = getSecurityScreenMetrics();
    assert.equal(m.unscreenableRate, 0.05);
    assert.equal(m.consecutiveUnscreenable, 1);
  });

  test('the streak alert fires once per episode, not once per turn', () => {
    let alerts = 0;
    const onAlert = (): void => {
      alerts += 1;
    };

    for (let i = 0; i < 50; i++) recordScreenOutcome('unscreenable', 'provider-rejected', onAlert);
    assert.equal(alerts, 1, 'a wedged screener must not emit 50 alerts');

    // A success closes the episode; the next streak is a new incident.
    recordScreenOutcome('allow', undefined, onAlert);
    assert.equal(getSecurityScreenMetrics().consecutiveUnscreenable, 0);
    for (let i = 0; i < UNSCREENABLE_STREAK_ALERT; i++) {
      recordScreenOutcome('unscreenable', 'provider-rejected', onAlert);
    }
    assert.equal(alerts, 2);
  });

  test('a streak below the threshold does not alert', () => {
    let alerts = 0;
    for (let i = 0; i < UNSCREENABLE_STREAK_ALERT - 1; i++) {
      recordScreenOutcome('unscreenable', 'unknown', () => {
        alerts += 1;
      });
    }
    assert.equal(alerts, 0, 'a transient miss is what fail-open is FOR');
  });

  test('the worst streak survives a recovery', () => {
    for (let i = 0; i < 7; i++) recordScreenOutcome('unscreenable', 'unknown', () => {});
    recordScreenOutcome('allow', undefined, () => {});

    const m = getSecurityScreenMetrics();
    assert.equal(m.consecutiveUnscreenable, 0);
    assert.equal(m.worstConsecutiveUnscreenable, 7, 'a lull must not erase the evidence');
  });

  test('the rate is 0 rather than NaN before anything is screened', () => {
    assert.equal(getSecurityScreenMetrics().unscreenableRate, 0);
  });

  test('the snapshot cannot be used to mutate the counters', () => {
    recordScreenOutcome('unscreenable', 'provider-rejected', () => {});
    const snapshot = getSecurityScreenMetrics();
    (snapshot.byCause as Record<string, number>)['provider-rejected'] = 999;

    assert.equal(getSecurityScreenMetrics().byCause['provider-rejected'], 1);
  });
});
