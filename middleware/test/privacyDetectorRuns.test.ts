import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PrivacyDetector,
  PrivacyDetectorOutcome,
  PrivacyReceipt,
} from '@omadia/plugin-api';

import {
  createPrivacyGuardService,
  REGEX_DETECTOR_ID,
} from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 3.2.1 — Detector-run transparency + debug-mode value retention.
//
// Pins the contract that:
//   - every registered detector contributes exactly one PrivacyDetectorRun
//     per turn (even if it never fires for the turn);
//   - status folds via worst-wins (error > timeout > skipped > ok);
//   - latency / hitCount / callCount accumulate across calls;
//   - debug_show_values=on emits values arrays for tokenized hits;
//   - debug_show_values=off keeps the receipt PII-free by construction.
// ---------------------------------------------------------------------------

const SAMPLE_EMAIL = 'max@firma.de';
const SECOND_EMAIL = 'lina@firma.de';

function fixedDetector(
  id: string,
  outcomeFor: (text: string) => PrivacyDetectorOutcome,
): PrivacyDetector {
  return {
    id,
    async detect(text: string) {
      return outcomeFor(text);
    },
  };
}

function emailHit(value: string, span: readonly [number, number]) {
  return {
    type: 'pii.email' as const,
    value,
    span,
    confidence: 0.98,
    detector: REGEX_DETECTOR_ID,
  };
}

describe('PrivacyGuardService · detector-run aggregation (Slice 3.2.1)', () => {
  it('records exactly one run per registered detector even with zero calls', async () => {
    // Detector list pre-touched by processOutbound — even an input that
    // gets transformed without firing the detector body still produces a
    // run row (callCount=0).
    const noopDetector = fixedDetector('noop:1', () => ({
      hits: [],
      status: 'ok',
    }));
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [noopDetector],
    });

    await service.processOutbound({
      sessionId: 's',
      turnId: 't-empty',
      systemPrompt: '',
      messages: [{ role: 'user', content: '' }],
    });
    const receipt = await service.finalizeTurn('t-empty');
    if (!receipt) throw new Error('expected receipt');

    assert.equal(receipt.detectorRuns.length, 1);
    const run = receipt.detectorRuns[0];
    assert.equal(run?.detector, 'noop:1');
    assert.equal(run?.status, 'ok');
    assert.equal(run?.callCount, 0, 'empty input never fires the detect() body');
    assert.equal(run?.hitCount, 0);
  });

  it('worst-status wins: error > timeout > skipped > ok across calls', async () => {
    let i = 0;
    const flaky = fixedDetector('flaky:1', () => {
      i++;
      if (i === 1) return { hits: [], status: 'ok' };
      if (i === 2) return { hits: [], status: 'skipped', reason: 'too-long' };
      if (i === 3) return { hits: [], status: 'timeout', reason: 't=5s' };
      return { hits: [], status: 'error', reason: 'http-503' };
    });
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [flaky],
    });

    for (let k = 0; k < 4; k++) {
      await service.processOutbound({
        sessionId: 's',
        turnId: 't-flaky',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: `x${String(k)}` }],
      });
    }
    const receipt = await service.finalizeTurn('t-flaky');
    if (!receipt) throw new Error('expected receipt');

    const run = receipt.detectorRuns[0];
    assert.equal(run?.status, 'error', 'error must win the worst-status fold');
    assert.equal(run?.reason, 'http-503');
    // 4 outbound calls × 2 targets each (sys + msg) = 8 detect calls
    assert.equal(run?.callCount, 8);
  });

  it('thrown exception is caught and surfaces as status:error with truncated reason', async () => {
    const broken: PrivacyDetector = {
      id: 'broken:1',
      async detect() {
        throw new Error('A'.repeat(200));
      },
    };
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [broken],
    });

    await service.processOutbound({
      sessionId: 's',
      turnId: 't-throw',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const receipt = await service.finalizeTurn('t-throw');
    if (!receipt) throw new Error('expected receipt');

    const run = receipt.detectorRuns[0];
    assert.equal(run?.status, 'error');
    assert.ok(run?.reason && run.reason.length <= 80, 'reason should be truncated to ≤80 chars');
  });

  it('latency accumulates across calls per detector', async () => {
    const slow = fixedDetector('slow:1', () => ({ hits: [], status: 'ok' }));
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [slow],
    });
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-lat',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const receipt = await service.finalizeTurn('t-lat');
    if (!receipt) throw new Error('expected receipt');
    const run = receipt.detectorRuns[0];
    assert.equal(run?.callCount, 2, 'sys + msg = 2 calls');
    assert.ok(run !== undefined && run.latencyMs >= 0, 'latency tracked');
  });
});

describe('PrivacyGuardService · debug_show_values flag (Slice 3.2.1)', () => {
  it('debug=off (default): receipt is PII-free — no values, no debug flag', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-clean',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail an ${SAMPLE_EMAIL} bitte.` }],
    });
    const receipt = (await service.finalizeTurn('t-clean')) as PrivacyReceipt;

    assert.equal(receipt.debug, undefined, 'no debug flag when default');
    for (const det of receipt.detections) {
      assert.equal(det.values, undefined, `no values on ${det.type}`);
    }
    // Defensive: original value is gone.
    assert.ok(!JSON.stringify(receipt).includes(SAMPLE_EMAIL));
  });

  it('debug=on: receipt carries debug:true + values for tokenized hits', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      debugShowValues: true,
    });
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-debug',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail an ${SAMPLE_EMAIL} bitte.` }],
    });
    const receipt = (await service.finalizeTurn('t-debug')) as PrivacyReceipt;

    assert.equal(receipt.debug, true);
    const det = receipt.detections.find((d) => d.type === 'pii.email');
    assert.ok(det);
    assert.deepEqual(det.values, [SAMPLE_EMAIL]);
  });

  it('debug=on: distinct values are deduped per (type, action, detector) bucket', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      debugShowValues: true,
    });
    // Two different emails + the same email twice.
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-dedup',
      systemPrompt: '',
      messages: [
        {
          role: 'user',
          content: `Mails an ${SAMPLE_EMAIL}, ${SECOND_EMAIL} und nochmal ${SAMPLE_EMAIL}.`,
        },
      ],
    });
    const receipt = (await service.finalizeTurn('t-dedup')) as PrivacyReceipt;
    const det = receipt.detections.find((d) => d.type === 'pii.email');
    assert.ok(det);
    assert.equal(det.count, 3, 'count counts every occurrence');
    assert.deepEqual(
      [...(det.values ?? [])].sort(),
      [SAMPLE_EMAIL, SECOND_EMAIL].sort(),
      'distinct values only',
    );
  });

  it('debug=on never emits values for redacted/blocked actions (destructive contract)', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      debugShowValues: true,
    });
    // api-key default action is `redacted` — value MUST not surface even
    // in debug mode.
    const SAMPLE_API_KEY = 'sk-abcdefghijklmnopqrstuvwx';
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-redact',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Try this key: ${SAMPLE_API_KEY}` }],
    });
    const receipt = (await service.finalizeTurn('t-redact')) as PrivacyReceipt;
    const det = receipt.detections.find((d) => d.type === 'pii.api_key');
    assert.ok(det);
    assert.equal(det.action, 'redacted');
    assert.equal(det.values, undefined, 'redacted action must not expose value');
    assert.ok(!JSON.stringify(receipt).includes(SAMPLE_API_KEY));
  });

  it('debug=on still passes the existing PII-free assertion for redacted-only payloads', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      debugShowValues: true,
    });
    const SAMPLE_API_KEY = 'pk-onlyapikeyhereXYZ12345';
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-redact-only',
      systemPrompt: '',
      messages: [{ role: 'user', content: `key=${SAMPLE_API_KEY}` }],
    });
    const receipt = await service.finalizeTurn('t-redact-only');
    if (!receipt) throw new Error('expected receipt');
    assert.ok(!JSON.stringify(receipt).includes(SAMPLE_API_KEY));
  });
});

describe('PrivacyReceipt schema (Slice 3.2.1)', () => {
  it('detectorRuns is always present in the receipt (may be empty)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-shape',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const receipt = await service.finalizeTurn('t-shape');
    if (!receipt) throw new Error('expected receipt');
    assert.ok(Array.isArray(receipt.detectorRuns));
  });
});

// Silence the unused-import linter: emailHit is exported for future tests
// that need a synthetic regex-shaped hit; not used in this file's body.
void emailHit;
