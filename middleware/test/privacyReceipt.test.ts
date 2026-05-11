import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ALL_PRIVACY_RECEIPT_FIXTURES,
  PRIVACY_REDACT_CAPABILITY,
  PRIVACY_REDACT_SERVICE_NAME,
  RECEIPT_FIXTURE_BLOCKED,
  RECEIPT_FIXTURE_DEGRADED,
  RECEIPT_FIXTURE_LOCAL_ROUTED,
  RECEIPT_FIXTURE_PASSED,
  RECEIPT_FIXTURE_TOKENIZED,
  type PrivacyReceipt,
} from '@omadia/plugin-api';

// ---------------------------------------------------------------------------
// Slice 1a: Shared PrivacyReceipt contract + fixtures.
//
// These tests pin the schema invariants the UI renderers (Slice 5/6) and the
// future detector wrapper (Slice 1b) will rely on. They are intentionally
// boring — schema drift here would silently break consumers.
// ---------------------------------------------------------------------------

const RECEIPT_ID_PATTERN = /^prv_\d{4}-\d{2}-\d{2}_[a-f0-9]{8,}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function assertReceiptShape(receipt: PrivacyReceipt, label: string): void {
  assert.match(
    receipt.receiptId,
    RECEIPT_ID_PATTERN,
    `${label}: receiptId must match prv_<date>_<hex>`,
  );
  assert.ok(
    ['pii-shield', 'data-residency'].includes(receipt.policyMode),
    `${label}: policyMode out of range`,
  );
  assert.ok(
    ['public-llm', 'local-llm', 'blocked'].includes(receipt.routing),
    `${label}: routing out of range`,
  );
  assert.ok(receipt.latencyMs >= 0, `${label}: latencyMs must be non-negative`);
  assert.match(receipt.auditHash, SHA256_HEX_PATTERN, `${label}: auditHash must be sha256 hex`);

  for (const [i, detection] of receipt.detections.entries()) {
    const dLabel = `${label}.detections[${i}]`;
    assert.ok(detection.type.length > 0, `${dLabel}: type must be non-empty`);
    assert.ok(detection.count >= 1, `${dLabel}: count must be ≥1`);
    assert.ok(
      ['redacted', 'tokenized', 'blocked', 'passed'].includes(detection.action),
      `${dLabel}: action out of range`,
    );
    assert.ok(detection.detector.includes(':'), `${dLabel}: detector must be 'name:version'`);
    assert.ok(
      detection.confidenceMin >= 0 && detection.confidenceMin <= 1,
      `${dLabel}: confidenceMin must be in [0, 1]`,
    );
  }
}

describe('plugin-api · privacy.redact@1 capability constants', () => {
  it('exports the canonical service name and capability id', () => {
    assert.equal(PRIVACY_REDACT_SERVICE_NAME, 'privacyRedact');
    assert.equal(PRIVACY_REDACT_CAPABILITY, 'privacy.redact@1');
  });
});

describe('plugin-api · PrivacyReceipt fixtures', () => {
  it('all fixtures satisfy the schema invariants', () => {
    for (const fixture of ALL_PRIVACY_RECEIPT_FIXTURES) {
      assertReceiptShape(fixture, fixture.receiptId);
    }
  });

  it('PASSED fixture is the green-badge happy path: no detections, public-llm', () => {
    assert.equal(RECEIPT_FIXTURE_PASSED.routing, 'public-llm');
    assert.equal(RECEIPT_FIXTURE_PASSED.detections.length, 0);
    assert.equal(RECEIPT_FIXTURE_PASSED.routingReason, undefined);
  });

  it('TOKENIZED fixture exercises the typical pii-shield flow', () => {
    assert.equal(RECEIPT_FIXTURE_TOKENIZED.policyMode, 'pii-shield');
    assert.equal(RECEIPT_FIXTURE_TOKENIZED.routing, 'public-llm');
    assert.ok(
      RECEIPT_FIXTURE_TOKENIZED.detections.every((d) => d.action === 'tokenized'),
      'all detections should be tokenized in this fixture',
    );
    assert.ok(RECEIPT_FIXTURE_TOKENIZED.detections.length >= 2, 'multi-detection coverage');
  });

  it('LOCAL_ROUTED fixture exercises the data-residency reroute', () => {
    assert.equal(RECEIPT_FIXTURE_LOCAL_ROUTED.policyMode, 'data-residency');
    assert.equal(RECEIPT_FIXTURE_LOCAL_ROUTED.routing, 'local-llm');
    assert.ok(
      RECEIPT_FIXTURE_LOCAL_ROUTED.routingReason &&
        RECEIPT_FIXTURE_LOCAL_ROUTED.routingReason.length > 0,
      'data-residency reroute must explain why',
    );
  });

  it('BLOCKED fixture aborts the request entirely with a reason', () => {
    assert.equal(RECEIPT_FIXTURE_BLOCKED.routing, 'blocked');
    assert.ok(
      RECEIPT_FIXTURE_BLOCKED.routingReason &&
        RECEIPT_FIXTURE_BLOCKED.routingReason.length > 0,
      'blocked routing must surface a routing reason',
    );
    assert.ok(
      RECEIPT_FIXTURE_BLOCKED.detections.some((d) => d.action === 'blocked'),
      'a blocked routing must be backed by at least one blocked detection',
    );
  });

  it('DEGRADED fixture flags fail-open with a non-empty reason', () => {
    assert.equal(RECEIPT_FIXTURE_DEGRADED.routing, 'public-llm');
    assert.ok(
      RECEIPT_FIXTURE_DEGRADED.routingReason &&
        RECEIPT_FIXTURE_DEGRADED.routingReason.includes('detector'),
      'degraded mode must mention the detector',
    );
  });

  it('receipts contain no PII-leaking fields (defensive shape check)', () => {
    // The receipt MUST NOT carry spans, offsets, or raw values. This test
    // pins the absence of those keys so a future contributor adding them
    // breaks the build instead of silently leaking PII into the channel
    // payload.
    const forbiddenKeys = ['spans', 'offsets', 'originalValues', 'tokens', 'tokenMap'];
    for (const fixture of ALL_PRIVACY_RECEIPT_FIXTURES) {
      const keys = Object.keys(fixture);
      for (const forbidden of forbiddenKeys) {
        assert.ok(
          !keys.includes(forbidden),
          `receipt ${fixture.receiptId} must not carry '${forbidden}'`,
        );
      }
    }
  });
});
