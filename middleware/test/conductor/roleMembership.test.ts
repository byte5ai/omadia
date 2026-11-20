/**
 * Spec 2042 §5.3 — the role-membership snapshot behind availability entries
 * `role:<key>`: synchronous, canonical, and fail closed (a partial lookup
 * admits nobody, a failed refresh keeps the last snapshot).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AggregateHolderLookup } from '@omadia/channel-sdk';

import { RoleMembershipSnapshot } from '../../src/conductor/roleMembership.js';

function lookup(holders: string[], partial = false): AggregateHolderLookup {
  return { holders, partial, bySource: [] };
}

describe('role membership snapshot', () => {
  it('answers from the snapshot, canonically; nobody before the first refresh', async () => {
    const snapshot = new RoleMembershipSnapshot({
      listRoleKeys: async () => ['HR-Team'],
      resolveHolders: async () => lookup(['jane@co.com']),
    });
    assert.equal(snapshot.hasRole('user:jane@co.com', 'HR-Team'), false);
    await snapshot.refresh();
    assert.equal(snapshot.hasRole('user:Jane@Co.com ', 'HR-Team'), true);
    assert.equal(snapshot.hasRole('user:jane@co.com', 'hr-team'), false, 'role keys keep their case');
    assert.equal(snapshot.hasRole('user:bob@co.com', 'HR-Team'), false);
    assert.equal(snapshot.hasRole('role:HR-Team', 'HR-Team'), false);
    assert.equal(snapshot.hasRole('garbage', 'HR-Team'), false);
  });

  it('a partial lookup admits nobody; a failed refresh keeps the last snapshot', async () => {
    let partial = false;
    let failList = false;
    const snapshot = new RoleMembershipSnapshot({
      listRoleKeys: async () => {
        if (failList) throw new Error('db down');
        return ['sales'];
      },
      resolveHolders: async () => lookup(['ann'], partial),
    });
    await snapshot.refresh();
    assert.equal(snapshot.hasRole('user:ann', 'sales'), true);
    failList = true;
    await snapshot.refresh();
    assert.equal(snapshot.hasRole('user:ann', 'sales'), true);
    failList = false;
    partial = true;
    await snapshot.refresh();
    assert.equal(snapshot.hasRole('user:ann', 'sales'), false);
  });

  it('refreshes during a running refresh coalesce into one more run, so the last change is seen', async () => {
    let holders = ['ann'];
    let reads = 0;
    const snapshot = new RoleMembershipSnapshot({
      listRoleKeys: async () => {
        reads += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return ['sales'];
      },
      resolveHolders: async () => lookup(holders),
    });
    const first = snapshot.refresh();
    holders = ['bob'];
    void snapshot.refresh();
    void snapshot.refresh();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reads, 2);
    assert.equal(snapshot.hasRole('user:bob', 'sales'), true);
  });
});
