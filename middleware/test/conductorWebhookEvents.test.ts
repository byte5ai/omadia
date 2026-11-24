import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { RunStatus } from '../src/conductor/runStore.js';
import {
  CONDUCTOR_WEBHOOK_EVENTS,
  isConductorWebhookEvent,
  runEndedEvent,
} from '../src/conductor/webhookEvents.js';

// #1705 — the status→event mapping used to be an inline ternary in index.ts's
// notifyRunEnded hook ("completed ? run.completed : run.failed"), which delivered an
// operator cancel as `run.failed` carrying `payload.status: "cancelled"`. It lives
// here now, so the mapping itself can be asserted without standing up a conductor.

describe('conductor webhook event vocabulary (#1705)', () => {
  it('maps each terminal run status to its own event name', () => {
    assert.equal(runEndedEvent('completed'), 'run.completed');
    assert.equal(runEndedEvent('failed'), 'run.failed');
    assert.equal(runEndedEvent('cancelled'), 'run.cancelled');
  });

  it('answers null for a status that is not terminal — never a fallback name', () => {
    assert.equal(runEndedEvent('running'), null);
    assert.equal(runEndedEvent('waiting'), null);
  });

  it('covers every RunStatus: each one either maps to a declared event or to null', () => {
    const all: RunStatus[] = ['running', 'waiting', 'completed', 'failed', 'cancelled'];
    for (const status of all) {
      const event = runEndedEvent(status);
      if (event !== null) {
        assert.ok(
          (CONDUCTOR_WEBHOOK_EVENTS as readonly string[]).includes(event),
          `'${status}' mapped to '${event}', which is not a declared event`,
        );
      }
    }
  });

  it('guards the subscribable vocabulary', () => {
    for (const event of CONDUCTOR_WEBHOOK_EVENTS) assert.ok(isConductorWebhookEvent(event));
    assert.equal(isConductorWebhookEvent('run.exploded'), false);
    assert.equal(isConductorWebhookEvent('run.cancelled '), false);
    assert.equal(isConductorWebhookEvent(''), false);
  });
});
