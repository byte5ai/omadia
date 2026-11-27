/**
 * ADR-0300 — deprovisioning in the directory service: audit first, a failed
 * token revocation marks the person for a retry, and the next run retries it.
 * Source ownership per tenant.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DirectorySource } from '@omadia/channel-sdk';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { DirectoryService } from '../src/directory/directoryService.js';
import type { DirectoryPerson, DirectoryStore } from '../src/directory/directoryStore.js';

const TENANT = '11111111-2222-4333-8444-555555555555';

const person: DirectoryPerson = {
  id: 'p1',
  source: 'entra',
  tenantId: TENANT,
  externalId: '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
  upn: null,
  mail: null,
  displayName: 'Paula',
  accountEnabled: false,
  status: 'active',
  firstSeenAt: new Date(0),
  syncedAt: new Date(0),
  deprovisionedAt: null,
};

function storeStub() {
  const marks: { id: string; pending: boolean }[] = [];
  const cleared: string[] = [];
  let pending: DirectoryPerson[] = [];
  const store = {
    markDeprovisioned: async (id: string, p = false) => {
      marks.push({ id, pending: p });
      if (p) pending = [{ ...person, status: 'deprovisioned' }];
    },
    listRevokePending: async () => pending,
    clearRevokePending: async (id: string) => {
      cleared.push(id);
      pending = [];
    },
    getSyncState: async () => ({ deltaCursor: 'd' }),
    markRunStarted: async () => undefined,
    markRunCompleted: async () => undefined,
    markRunFailed: async () => undefined,
  } as unknown as DirectoryStore;
  return { store, marks, cleared };
}

const source: DirectorySource = {
  source: 'entra',
  tenantId: TENANT,
  delta: async () => ({ outcome: 'page', page: { changes: [], deltaCursor: 'd2' } }),
};

describe('ADR-0300 · directory service', () => {
  it('audits, revokes, unlinks, then marks; a failed revocation is retried next run', async () => {
    const { store, marks, cleared } = storeStub();
    const order: string[] = [];
    const audit: AuditEntryInput[] = [];
    let attempts = 0;
    const service = new DirectoryService({
      store: () => store,
      audit: () => ({
        record: async (e) => {
          order.push('audit');
          audit.push(e);
        },
      }),
      revokePersonConnections: async () => {
        order.push('revoke');
        attempts += 1;
        return attempts === 1 ? { revoked: 1, failed: 1 } : { revoked: 1, failed: 0 };
      },
      unlinkPersonIdentities: async () => {
        order.push('unlink');
        return 0;
      },
      accountStatus: async () => 'active',
      log: () => undefined,
    });
    await service.deprovision(person, 'disabled');
    assert.deepEqual(order, ['audit', 'revoke', 'unlink']);
    assert.equal(audit[0]?.action, 'directory_person.deprovision');
    assert.deepEqual(marks, [{ id: 'p1', pending: true }]);

    service.register('@omadia/channel-teams', source);
    const out = await service.sync('entra', TENANT);
    service.stop();
    assert.equal(out?.outcome, 'completed');
    assert.equal(attempts, 2);
    assert.deepEqual(cleared, ['p1']);
  });

  it('a failed audit write does not keep a leaver active', async () => {
    const { store, marks } = storeStub();
    const service = new DirectoryService({
      store: () => store,
      audit: () => ({
        record: async () => {
          throw new Error('db down');
        },
      }),
      revokePersonConnections: async () => ({ revoked: 0, failed: 0 }),
      unlinkPersonIdentities: async () => 0,
      accountStatus: async () => undefined,
      log: () => undefined,
    });
    await service.deprovision(person, 'removed');
    assert.deepEqual(marks, [{ id: 'p1', pending: false }]);
  });

  it('a tenant belongs to the first plugin that registers it', () => {
    const { store } = storeStub();
    const service = new DirectoryService({
      store: () => store,
      audit: () => undefined,
      revokePersonConnections: async () => ({ revoked: 0, failed: 0 }),
      unlinkPersonIdentities: async () => 0,
      accountStatus: async () => undefined,
      log: () => undefined,
      intervalMs: 60_000,
    });
    service.register('@omadia/channel-teams', source);
    assert.throws(() => service.register('@acme/other', source), /already belongs/);
    assert.throws(() => service.register('@acme/other', { ...source, tenantId: 'not-a-guid' }), /unknown kind or tenant/);
    service.unregisterChannel('@omadia/channel-teams');
    service.register('@acme/other', source);
    service.stop();
    assert.equal(service.registeredSources()[0]?.channelId, '@acme/other');
  });

  it('refuses an Entra source from a plugin that does not serve Teams', () => {
    const { store } = storeStub();
    const service = new DirectoryService({
      store: () => store,
      audit: () => undefined,
      revokePersonConnections: async () => ({ revoked: 0, failed: 0 }),
      unlinkPersonIdentities: async () => 0,
      accountStatus: async () => undefined,
      mayRegister: (channelId) => channelId === '@omadia/channel-teams',
      log: () => undefined,
    });
    assert.throws(() => service.register('@omadia/channel-telegram', source), /does not serve/);
    service.register('@omadia/channel-teams', source);
    service.stop();
  });
});
