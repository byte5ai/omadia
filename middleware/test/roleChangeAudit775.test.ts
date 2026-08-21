/**
 * #775 — the conductor role-holders audit entry must actually land.
 *
 * The defect: `auditRoleChange` passed the session sub (an EMAIL under local
 * auth) as `actor.id`; `admin_audit.actor_id` is a uuid column, so every
 * write failed and the audit trail for baton moves — the whole point of
 * #759 — stayed empty on the normal local-auth install. Loud in the log,
 * invisible on the PR: no test drove the closure with an email sub.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { roleChangeAuditEntry } from '../src/auth/adminAuditLog.js';

describe('#775 roleChangeAuditEntry', () => {
  test('an email sub never lands in the uuid id slot', () => {
    const entry = roleChangeAuditEntry({
      actor: 'demo@byte5.de',
      roleKey: 'release-approver',
      action: 'add',
      holderId: 'user:u-2',
      holdersAfter: ['user:u-1', 'user:u-2'],
    });

    assert.equal(entry.actor.id, undefined, 'no uuid in the session -> id stays empty');
    assert.equal(entry.actor.email, 'demo@byte5.de');
    assert.equal(entry.action, 'conductor.role_holders_change');
    assert.equal(entry.target, 'conductor-role:release-approver');
  });

  test('a session uuid is threaded to id, the sub still to email', () => {
    const entry = roleChangeAuditEntry({
      actor: 'demo@byte5.de',
      actorUserId: '3f2c8d1e-0000-4000-8000-000000000001',
      roleKey: 'release-approver',
      action: 'remove',
      holderId: 'user:u-2',
      holdersAfter: ['user:u-1'],
    });

    assert.equal(entry.actor.id, '3f2c8d1e-0000-4000-8000-000000000001');
    assert.equal(entry.actor.email, 'demo@byte5.de');
  });

  test('the operator fallback is preserved rather than dropped', () => {
    // No session at all: the closure used to lose nothing here by accident
    // (the string 'operator' also failed the uuid cast). The mapper keeps it
    // in the free-text email column — an audit row with no actor at all
    // would be worse than one with a non-address marker.
    const entry = roleChangeAuditEntry({
      actor: 'operator',
      roleKey: 'r',
      action: 'add',
      holderId: 'user:u-1',
      holdersAfter: ['user:u-1'],
    });

    assert.equal(entry.actor.id, undefined);
    assert.equal(entry.actor.email, 'operator');
  });
});
