/**
 * #1707 — webhook administration must leave a trail.
 *
 * The defect: `SELECT action FROM admin_audit WHERE action ILIKE '%webhook%'`
 * returned no rows on an install that had been creating, rotating, disabling and
 * deleting webhook endpoints and subscriptions all along. Those actions decide what
 * may start a workflow run and where run data is sent, so they belong in the same
 * trail as the role batons (#759).
 *
 * The mapping lives in `webhookChangeAuditEntry` for the #775 reason: an email sub
 * must never reach the uuid `admin_audit.actor_id`, and that rule needs a test that
 * drives it with an email.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { webhookChangeAuditEntry } from '../src/auth/adminAuditLog.js';

describe('#1707 webhookChangeAuditEntry', () => {
  test('an email sub never lands in the uuid id slot', () => {
    const entry = webhookChangeAuditEntry({
      actor: 'demo@byte5.de',
      kind: 'endpoint',
      change: 'create',
      id: 'ab12cd34',
      after: { eventId: 'orders.created', enabled: true },
    });

    assert.equal(entry.actor.id, undefined);
    assert.equal(entry.actor.email, 'demo@byte5.de');
    assert.equal(entry.action, 'conductor.webhook_endpoint_create');
    assert.equal(entry.target, 'conductor-webhook-endpoint:ab12cd34');
  });

  test('a session uuid is threaded to id, the sub still to email', () => {
    const entry = webhookChangeAuditEntry({
      actor: 'demo@byte5.de',
      actorUserId: '3f2c8d1e-0000-4000-8000-000000000001',
      kind: 'subscription',
      change: 'delete',
      id: '0f9a1b2c-0000-4000-8000-000000000002',
      before: { url: 'https://example.com/hook', event: 'run.completed', enabled: true },
    });

    assert.equal(entry.actor.id, '3f2c8d1e-0000-4000-8000-000000000001');
    assert.equal(entry.actor.email, 'demo@byte5.de');
    assert.equal(entry.action, 'conductor.webhook_subscription_delete');
  });

  test('every change maps to a distinct, %webhook%-matching action', () => {
    const actions = [
      webhookChangeAuditEntry({ actor: 'o', kind: 'endpoint', change: 'create', id: 'e' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'endpoint', change: 'rotate_secret', id: 'e' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'endpoint', change: 'status', id: 'e' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'endpoint', change: 'delete', id: 'e' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'subscription', change: 'create', id: 's' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'subscription', change: 'rotate_secret', id: 's' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'subscription', change: 'status', id: 's' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'subscription', change: 'delete', id: 's' }).action,
      webhookChangeAuditEntry({ actor: 'o', kind: 'subscription', change: 'payload_scope', id: 's' }).action,
    ];

    assert.equal(new Set(actions).size, actions.length, 'two changes must never share one action');
    // The reported query is `ILIKE '%webhook%'` — every one of these has to answer it.
    for (const action of actions) assert.ok(action.includes('webhook'), action);
  });

  test('before/after are omitted rather than written as nulls', () => {
    const entry = webhookChangeAuditEntry({ actor: 'operator', kind: 'endpoint', change: 'status', id: 'e' });
    assert.equal('before' in entry, false);
    assert.equal('after' in entry, false);
    assert.equal(entry.actor.email, 'operator', 'the operator fallback is preserved, not dropped');
  });
});
