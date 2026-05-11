/**
 * Mock `PrivacyReceipt` fixtures for UI development and tests.
 *
 * Slice 1a ships these so the Web (Slice 5) and Teams (Slice 6) renderers
 * can implement against realistic data shapes before Slice 1b lands the
 * actual wrapper + detector. Once the backend is live the renderers swap
 * the fixture import for the real receipt-from-message-metadata path —
 * the type stays identical.
 *
 * Keep these representative of the four interesting UI states:
 *   1. Nothing detected (happy path, green badge)
 *   2. PII tokenised (typical pii-shield turn, yellow badge)
 *   3. Hard-blocked (data-residency strict mode, red badge)
 *   4. Detector degraded (fail-open path, yellow badge with warning)
 */

import type { PrivacyReceipt } from './privacyReceipt.js';

/** Happy-path: no detections, request went to public LLM unmodified. */
export const RECEIPT_FIXTURE_PASSED: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_a3f9c2d1',
  policyMode: 'pii-shield',
  routing: 'public-llm',
  detections: [],
  latencyMs: 12,
  auditHash: 'a3f9c2d18b4e7f6a92c0d3e1f8b2c5d7e9a1b4c6f8e0d2a5c7b9f1e3d6a8c0b2',
  detectorRuns: [
    { detector: 'regex:0.1.0', status: 'ok', callCount: 1, hitCount: 0, latencyMs: 3 },
  ],
};

/** Typical pii-shield turn: e-mail + IBAN tokenised reversibly so the user
 *  still sees the real values in the assistant's reply. */
export const RECEIPT_FIXTURE_TOKENIZED: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_b4e7f2a9',
  policyMode: 'pii-shield',
  routing: 'public-llm',
  detections: [
    {
      type: 'pii.email',
      count: 2,
      action: 'tokenized',
      detector: 'presidio:2.2.351',
      confidenceMin: 0.98,
    },
    {
      type: 'pii.iban',
      count: 1,
      action: 'tokenized',
      detector: 'presidio:2.2.351',
      confidenceMin: 0.99,
    },
  ],
  latencyMs: 47,
  auditHash: 'b4e7f2a96d8c1e4f3a7b9d2c5e8f1a4d6c9b2e5f8a1d4c7b0e3f6a9d2c5b8e1f',
  detectorRuns: [
    { detector: 'presidio:2.2.351', status: 'ok', callCount: 1, hitCount: 3, latencyMs: 31 },
  ],
};

/** Data-residency strict: customer_data label triggered hard-block of the
 *  public LLM; request was rerouted to the local Ollama sidecar. */
export const RECEIPT_FIXTURE_LOCAL_ROUTED: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_c5d8a1b3',
  policyMode: 'data-residency',
  routing: 'local-llm',
  routingReason: 'tenant label customer_data',
  detections: [
    {
      type: 'custom.customer_data',
      count: 1,
      action: 'blocked',
      detector: 'presidio:2.2.351',
      confidenceMin: 1.0,
    },
    {
      type: 'pii.contract_clause',
      count: 3,
      action: 'tokenized',
      detector: 'ollama:llama3.2:3b',
      confidenceMin: 0.74,
    },
  ],
  latencyMs: 142,
  auditHash: 'c5d8a1b34f7c0e3a6d9b2e5f8a1c4d7b0e3f6a9c2b5d8a1e4f7c0b3d6a9e2f5c',
  detectorRuns: [
    { detector: 'presidio:2.2.351', status: 'ok', callCount: 1, hitCount: 1, latencyMs: 18 },
    { detector: 'ollama:llama3.2:3b', status: 'ok', callCount: 1, hitCount: 3, latencyMs: 117 },
  ],
};

/** Hard-block: api-key detected, request aborted entirely. Nothing was
 *  sent to any LLM. */
export const RECEIPT_FIXTURE_BLOCKED: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_d6c9e2f4',
  policyMode: 'pii-shield',
  routing: 'blocked',
  routingReason: 'strict policy: api-key detected',
  detections: [
    {
      type: 'pii.api_key',
      count: 1,
      action: 'blocked',
      detector: 'presidio:2.2.351',
      confidenceMin: 0.95,
    },
  ],
  latencyMs: 8,
  auditHash: 'd6c9e2f45a8d1b4e7c0f3a6d9b2e5c8f1a4d7c0b3e6f9a2d5c8b1e4f7a0d3c6b',
  detectorRuns: [
    { detector: 'presidio:2.2.351', status: 'ok', callCount: 1, hitCount: 1, latencyMs: 6 },
  ],
};

/** Detector unavailable, agent had `privacy.fail_open: true` so the request
 *  proceeded with a `degraded` flag in the receipt. UI renders this with
 *  a warning banner. */
export const RECEIPT_FIXTURE_DEGRADED: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_e7f0a3c5',
  policyMode: 'pii-shield',
  routing: 'public-llm',
  routingReason: 'detector unavailable; agent fail-open',
  detections: [],
  latencyMs: 2003,
  auditHash: 'e7f0a3c56b9d2c5f8a1d4c7b0e3f6a9d2c5b8e1f4a7d0c3b6e9f2a5d8c1b4e7f',
  detectorRuns: [
    { detector: 'regex:0.1.0', status: 'ok', callCount: 1, hitCount: 0, latencyMs: 2 },
    {
      detector: 'ollama:llama3.2:3b',
      status: 'timeout',
      callCount: 1,
      hitCount: 0,
      latencyMs: 2000,
      reason: 'sidecar unreachable',
    },
  ],
};

/** Slice 3.2.1 debug-mode example: operator enabled `debug_show_values=on`,
 *  receipt now carries the actual matched substrings inside `values`.
 *  ONLY used in self-hosted dev/preview tenants — production receipts
 *  must not include `values`. */
export const RECEIPT_FIXTURE_DEBUG_VALUES: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_f8a1b4c6',
  policyMode: 'pii-shield',
  routing: 'public-llm',
  detections: [
    {
      type: 'pii.name',
      count: 1,
      action: 'tokenized',
      detector: 'ollama:llama3.2:3b',
      confidenceMin: 0.96,
      values: ['John Doe'],
    },
    {
      type: 'pii.email',
      count: 2,
      action: 'tokenized',
      detector: 'regex:0.1.0',
      confidenceMin: 0.98,
      values: ['john.doe@byte5.de', 'support@byte5.de'],
    },
  ],
  latencyMs: 4123,
  auditHash: 'f8a1b4c69d2c5b8e1f4a7d0c3b6e9f2a5d8c1b4e7c0f3a6d9b2e5c8f1a4d7c0b',
  detectorRuns: [
    { detector: 'regex:0.1.0', status: 'ok', callCount: 1, hitCount: 2, latencyMs: 4 },
    { detector: 'ollama:llama3.2:3b', status: 'ok', callCount: 1, hitCount: 1, latencyMs: 4119 },
  ],
  debug: true,
};

/** Convenience array for tests / Storybook iteration. Covers every
 *  interesting UI state in stable order. */
export const ALL_PRIVACY_RECEIPT_FIXTURES: readonly PrivacyReceipt[] = [
  RECEIPT_FIXTURE_PASSED,
  RECEIPT_FIXTURE_TOKENIZED,
  RECEIPT_FIXTURE_LOCAL_ROUTED,
  RECEIPT_FIXTURE_BLOCKED,
  RECEIPT_FIXTURE_DEGRADED,
  RECEIPT_FIXTURE_DEBUG_VALUES,
];
