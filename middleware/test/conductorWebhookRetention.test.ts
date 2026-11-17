import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { JsonObject } from '@omadia/conductor-core';

import { projectRunEventPayload } from '../src/conductor/webhookPayload.js';
import {
  MIN_RETENTION_DAYS,
  resolveRetentionWindows,
  startWebhookPayloadRetention,
} from '../src/conductor/webhookRetention.js';
import type { ConductorWebhookSubscriptionStore } from '../src/conductor/webhookSubscriptionStore.js';

// Issue #1707 — two halves of "what leaves the server and how long it stays":
// the per-subscription payload projection, and the retention sweep over the stored
// payloads. The reported leak was a human's free text ("kommentar": "P09
// Testkommentar") both delivered to an external receiver and kept in
// `conductor_webhook_deliveries.payload` for the lifetime of the install.

const RUN_EVENT: JsonObject = {
  runId: 'run-1',
  status: 'completed',
  workflowSlug: 'freigabe',
  workflowName: 'Freigabe',
  triggerKind: 'manual',
  context: { steps: { freigabe: { approved: false, kommentar: 'P09 Testkommentar' } } },
  errorCode: null,
  errorMessage: null,
};

describe('projectRunEventPayload (#1707)', () => {
  it('drops the context for an opted-out subscription and says so', () => {
    const projected = projectRunEventPayload(RUN_EVENT, { includeContext: false });
    assert.equal(projected['context'], undefined);
    assert.equal(projected['contextOmitted'], true);
    assert.equal(JSON.stringify(projected).includes('P09 Testkommentar'), false);
  });

  it('keeps every non-context field — the receiver still gets a usable event', () => {
    const projected = projectRunEventPayload(RUN_EVENT, { includeContext: false });
    assert.equal(projected['runId'], 'run-1');
    assert.equal(projected['status'], 'completed');
    assert.equal(projected['workflowSlug'], 'freigabe');
    assert.equal(projected['workflowName'], 'Freigabe');
    assert.equal(projected['triggerKind'], 'manual');
    assert.equal(projected['errorCode'], null);
  });

  it('passes the event through untouched when the subscription opted in', () => {
    const projected = projectRunEventPayload(RUN_EVENT, { includeContext: true });
    assert.deepEqual(projected, RUN_EVENT);
  });

  it('never mutates the shared event — one build is fanned out to every subscription', () => {
    const full: JsonObject = { ...RUN_EVENT };
    projectRunEventPayload(full, { includeContext: false });
    assert.deepEqual(full['context'], RUN_EVENT['context']);
  });

  it('`contextOmitted` distinguishes "not allowed to see it" from "there was none"', () => {
    const noContext: JsonObject = { runId: 'run-2', status: 'failed' };
    assert.equal(projectRunEventPayload(noContext, { includeContext: true })['contextOmitted'], undefined);
    assert.equal(projectRunEventPayload(noContext, { includeContext: false })['contextOmitted'], true);
  });
});

describe('resolveRetentionWindows (#1707)', () => {
  // The floor is not cosmetic: the retry worker's reconciliation pass looks back 24h
  // for terminal runs with no delivery row, so a window inside that lookback would
  // let the sweep delete a row the pass then recreates — re-sending a webhook the
  // receiver already got, forever.
  it('clamps both windows up to the floor', () => {
    assert.deepEqual(resolveRetentionWindows({ payloadRetentionDays: 0, deliveryRetentionDays: 1 }), {
      payloadRetentionDays: MIN_RETENTION_DAYS,
      deliveryRetentionDays: MIN_RETENTION_DAYS,
    });
  });

  it('never deletes a row before its payload would have been redacted', () => {
    assert.deepEqual(resolveRetentionWindows({ payloadRetentionDays: 90, deliveryRetentionDays: 30 }), {
      payloadRetentionDays: 90,
      deliveryRetentionDays: 90,
    });
  });

  it('leaves a sane configuration alone', () => {
    assert.deepEqual(resolveRetentionWindows({ payloadRetentionDays: 30, deliveryRetentionDays: 180 }), {
      payloadRetentionDays: 30,
      deliveryRetentionDays: 180,
    });
  });
});

interface SweepCalls {
  redact: number[];
  purge: number[];
}

function fakeStore(calls: SweepCalls, opts: { throwOnRedact?: boolean } = {}): ConductorWebhookSubscriptionStore {
  return {
    async redactDeliveryPayloadsOlderThan(days: number) {
      calls.redact.push(days);
      if (opts.throwOnRedact === true) throw new Error('sweep exploded');
      return 2;
    },
    async deleteDeliveriesOlderThan(days: number) {
      calls.purge.push(days);
      return 1;
    },
  } as unknown as ConductorWebhookSubscriptionStore;
}

describe('startWebhookPayloadRetention (#1707)', () => {
  it('sweeps eagerly on start with the CLAMPED windows', async () => {
    const calls: SweepCalls = { redact: [], purge: [] };
    const handle = startWebhookPayloadRetention({
      store: fakeStore(calls),
      payloadRetentionDays: 1, // below the floor
      deliveryRetentionDays: 180,
      intervalMs: 60_000,
    });
    try {
      // The boot pass is fire-and-forget; let its microtasks drain.
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(calls.redact, [MIN_RETENTION_DAYS]);
      assert.deepEqual(calls.purge, [180]);
    } finally {
      handle.stop();
    }
  });

  it('a failing sweep is logged, never thrown — the next tick retries', async () => {
    const calls: SweepCalls = { redact: [], purge: [] };
    const logs: string[] = [];
    const handle = startWebhookPayloadRetention({
      store: fakeStore(calls, { throwOnRedact: true }),
      payloadRetentionDays: 30,
      deliveryRetentionDays: 180,
      intervalMs: 60_000,
      log: (m) => logs.push(m),
    });
    try {
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.purge.length, 0, 'the delete must not run on a half-failed sweep');
      assert.ok(logs.some((l) => l.includes('retention sweep failed')), logs.join('\n'));
    } finally {
      handle.stop();
    }
  });
});
