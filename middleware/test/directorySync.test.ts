/**
 * ADR-0300 — one sync run of a directory source: full read, delta read,
 * removed/disabled people, deprovisioning after a completed full read only,
 * and a broken run that keeps the old cursor.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DirectoryDeltaResult, DirectorySource } from '@omadia/channel-sdk';

import type { DirectoryPerson, DirectoryPersonUpsert, DirectorySyncState } from '../src/directory/directoryStore.js';
import { runDirectorySync, type DeprovisionReason } from '../src/directory/directorySync.js';

const TENANT = '11111111-2222-4333-8444-555555555555';

/** The subset of `DirectoryStore` the sync uses, in memory. */
class FakeStore {
  people = new Map<string, DirectoryPerson & { seenInRun: string | null }>();
  state: DirectorySyncState | null = null;
  completed: { cursor: string; full: boolean }[] = [];
  failures: string[] = [];

  async getSyncState(): Promise<DirectorySyncState | null> {
    return this.state;
  }
  async markRunStarted(): Promise<void> {}
  async markRunCompleted(_s: string, _t: string, cursor: string, full: boolean): Promise<void> {
    this.completed.push({ cursor, full });
    this.state = { ...(this.state ?? emptyState()), deltaCursor: cursor };
  }
  async markRunFailed(_s: string, _t: string, error: string, clearCursor = false): Promise<void> {
    this.failures.push(error);
    if (clearCursor && this.state) this.state = { ...this.state, deltaCursor: null };
  }
  async upsert(_s: string, tenantId: string, change: DirectoryPersonUpsert, runId: string | null) {
    const prev = this.people.get(change.externalId);
    const accountEnabled = change.accountEnabled ?? prev?.accountEnabled ?? true;
    const person = {
      id: prev?.id ?? `p-${change.externalId}`,
      source: 'entra' as const,
      tenantId,
      externalId: change.externalId,
      upn: change.upn ?? prev?.upn ?? null,
      mail: change.mail ?? prev?.mail ?? null,
      displayName: change.displayName ?? prev?.displayName ?? '',
      accountEnabled,
      status: accountEnabled ? ('active' as const) : (prev?.status ?? ('active' as const)),
      firstSeenAt: new Date(),
      syncedAt: new Date(),
      deprovisionedAt: null,
      seenInRun: runId ?? prev?.seenInRun ?? null,
    };
    this.people.set(change.externalId, person);
    return { person, reactivated: false };
  }
  async findByExternalId(_s: string, _t: string, externalId: string) {
    return this.people.get(externalId) ?? null;
  }
  async countActive() {
    return [...this.people.values()].filter((p) => p.status === 'active').length;
  }
  async listUnseenActive(_s: string, _t: string, runId: string) {
    return [...this.people.values()].filter((p) => p.status === 'active' && p.seenInRun !== runId);
  }
}

function emptyState(): DirectorySyncState {
  return {
    source: 'entra',
    tenantId: TENANT,
    deltaCursor: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFullAt: null,
    lastError: null,
  };
}

function scriptedSource(pages: Record<string, DirectoryDeltaResult>): DirectorySource & { calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  return {
    source: 'entra',
    tenantId: TENANT,
    calls,
    async delta(cursor) {
      calls.push(cursor);
      const page = pages[cursor ?? 'START'];
      if (!page) throw new Error(`no page for ${String(cursor)}`);
      return page;
    },
  };
}

function harness(store: FakeStore) {
  const deprovisioned: { externalId: string; reason: DeprovisionReason }[] = [];
  return {
    deprovisioned,
    deps: {
      store,
      deprovision: async (person: DirectoryPerson, reason: DeprovisionReason) => {
        deprovisioned.push({ externalId: person.externalId, reason });
        const p = store.people.get(person.externalId);
        if (p) store.people.set(person.externalId, { ...p, status: 'deprovisioned' });
      },
      log: () => undefined,
    },
  };
}

const page = (changes: unknown[], next: { nextCursor?: string; deltaCursor?: string }): DirectoryDeltaResult => ({
  outcome: 'page',
  page: { changes: changes as never, ...next },
});

describe('ADR-0300 · directory sync', () => {
  it('reads in full across pages and stores the delta cursor', async () => {
    const store = new FakeStore();
    const { deps, deprovisioned } = harness(store);
    const source = scriptedSource({
      START: page([{ externalId: 'A-1', displayName: 'Anna' }], { nextCursor: 'p2' }),
      p2: page([{ externalId: 'b-2', displayName: 'Ben' }], { deltaCursor: 'd1' }),
    });
    const out = await runDirectorySync(source, deps);
    assert.deepEqual(out, { outcome: 'completed', full: true, applied: 2, deprovisioned: 0 });
    assert.ok(store.people.has('a-1'), 'object ids are stored lower-case');
    assert.deepEqual(store.completed, [{ cursor: 'd1', full: true }]);
    assert.deepEqual(deprovisioned, []);
  });

  it('deprovisions removed and disabled people on a delta read', async () => {
    const store = new FakeStore();
    const { deps, deprovisioned } = harness(store);
    await runDirectorySync(
      scriptedSource({ START: page([{ externalId: 'a' }, { externalId: 'b' }], { deltaCursor: 'd1' }) }),
      deps,
    );
    const out = await runDirectorySync(
      scriptedSource({ d1: page([{ externalId: 'a', removed: true }, { externalId: 'b', accountEnabled: false }], { deltaCursor: 'd2' }) }),
      deps,
    );
    assert.equal(out.outcome, 'completed');
    assert.deepEqual(deprovisioned, [
      { externalId: 'a', reason: 'removed' },
      { externalId: 'b', reason: 'disabled' },
    ]);
  });

  it('deprovisions people a completed full read no longer lists', async () => {
    const store = new FakeStore();
    const { deps, deprovisioned } = harness(store);
    await runDirectorySync(scriptedSource({ START: page([{ externalId: 'a' }, { externalId: 'b' }], { deltaCursor: 'd1' }) }), deps);
    // The source rejects the stored cursor: a fresh full read follows.
    const out = await runDirectorySync(
      scriptedSource({ d1: { outcome: 'resync' }, START: page([{ externalId: 'a' }], { deltaCursor: 'd9' }) }),
      deps,
    );
    assert.equal(out.outcome, 'completed');
    assert.deepEqual(deprovisioned, [{ externalId: 'b', reason: 'not_in_full_read' }]);
  });

  it('a broken full read deprovisions nobody and keeps the old cursor', async () => {
    const store = new FakeStore();
    const { deps, deprovisioned } = harness(store);
    await runDirectorySync(scriptedSource({ START: page([{ externalId: 'a' }, { externalId: 'b' }], { deltaCursor: 'd1' }) }), deps);
    const out = await runDirectorySync(
      scriptedSource({
        d1: { outcome: 'resync' },
        START: page([{ externalId: 'a' }], { nextCursor: 'p2' }),
        p2: { outcome: 'unavailable', message: 'graph 503' },
      }),
      deps,
    );
    assert.deepEqual(out, { outcome: 'failed', error: 'graph 503' });
    assert.deepEqual(deprovisioned, []);
    assert.equal(store.state?.deltaCursor, 'd1');
  });

  it('a source that throws, or ends without a cursor, fails the run', async () => {
    const store = new FakeStore();
    const { deps } = harness(store);
    assert.equal((await runDirectorySync(scriptedSource({}), deps)).outcome, 'failed');
    assert.equal((await runDirectorySync(scriptedSource({ START: page([], {}) }), deps)).outcome, 'failed');
    assert.equal(store.completed.length, 0);
  });

  it('skips malformed changes', async () => {
    const store = new FakeStore();
    const { deps } = harness(store);
    const out = await runDirectorySync(
      scriptedSource({ START: page([{ externalId: '' }, { nope: 1 }, null, { externalId: 'a' }], { deltaCursor: 'd' }) }),
      deps,
    );
    assert.deepEqual(out, { outcome: 'completed', full: true, applied: 1, deprovisioned: 0 });
  });

  it('refuses a full read that would deprovision most of the tenant', async () => {
    const store = new FakeStore();
    const { deps, deprovisioned } = harness(store);
    const many = Array.from({ length: 12 }, (_, i) => ({ externalId: `u${String(i)}` }));
    await runDirectorySync(scriptedSource({ START: page(many, { deltaCursor: 'd1' }) }), deps);
    const out = await runDirectorySync(
      scriptedSource({ d1: { outcome: 'resync' }, START: page(many.slice(0, 2), { deltaCursor: 'd2' }) }),
      deps,
    );
    assert.equal(out.outcome, 'failed');
    assert.deepEqual(deprovisioned, []);
  });
});
