import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { WorkaroundStateStore } from '../../src/plugins/builder/workaroundStateStore.js';
import type { Workaround } from '../../src/plugins/builder/types.js';

function makeWorkaround(overrides: Partial<Workaround> = {}): Workaround {
  return {
    id: overrides.id ?? 'w-1',
    fingerprint: overrides.fingerprint ?? 'fp-1',
    summary: overrides.summary ?? 'workaround',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    issueRef:
      overrides.issueRef ?? {
        owner: 'byte5ai',
        repo: 'omadia',
        number: 42,
        url: 'https://github.com/byte5ai/omadia/issues/42',
      },
  };
}

describe('WorkaroundStateStore', () => {
  let tmp: string;
  let dbPath: string;
  let draftStore: DraftStore;
  let store: WorkaroundStateStore;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workaround-state-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    if (draftStore) await draftStore.close();
    dbPath = join(tmp, `state-${String(Date.now())}-${String(Math.random())}.db`);
    draftStore = new DraftStore({ dbPath });
    await draftStore.open();
    store = new WorkaroundStateStore({ dbPath });
    await store.open();
  });

  it('markActive creates a new row and getOperationalState returns it', () => {
    store.markActive({
      installedAgentId: 'de.byte5.agent.weather',
      workaround: makeWorkaround(),
    });
    const state = store.getOperationalState({
      installedAgentId: 'de.byte5.agent.weather',
      workaroundId: 'w-1',
    });
    assert.ok(state);
    assert.equal(state.status, 'active');
    assert.equal(state.resolvedAt, null);
    assert.equal(state.createdAt, 1_700_000_000_000);
  });

  it('markActive is idempotent and preserves createdAt + patch context', () => {
    store.markActive({
      installedAgentId: 'agent-x',
      workaround: makeWorkaround(),
      patchContext: {
        fingerprint: 'fp-1',
        reasoning: 'because',
        relevantFiles: ['src/slots/foo.ts'],
      },
    });
    // Second call with no patchContext: should NOT wipe the first context.
    store.markActive({
      installedAgentId: 'agent-x',
      workaround: makeWorkaround({ createdAt: 9_999_999 }),
    });
    const state = store.getOperationalState({
      installedAgentId: 'agent-x',
      workaroundId: 'w-1',
    });
    assert.ok(state);
    assert.equal(state.createdAt, 1_700_000_000_000, 'createdAt preserved');
    assert.ok(state.patchContext);
    assert.equal(state.patchContext.reasoning, 'because');
  });

  it('markResolved flips status + stamps resolved_at', () => {
    store.markActive({
      installedAgentId: 'agent-y',
      workaround: makeWorkaround(),
    });
    const ok = store.markResolved({
      installedAgentId: 'agent-y',
      workaroundId: 'w-1',
    });
    assert.equal(ok, true);
    const state = store.getOperationalState({
      installedAgentId: 'agent-y',
      workaroundId: 'w-1',
    });
    assert.ok(state);
    assert.equal(state.status, 'resolved');
    assert.ok(state.resolvedAt && state.resolvedAt > 0);
  });

  it('initializeForInstall persists every workaround from the spec', () => {
    store.initializeForInstall({
      installedAgentId: 'agent-z',
      workarounds: [
        makeWorkaround({ id: 'w-a', fingerprint: 'fp-a' }),
        makeWorkaround({ id: 'w-b', fingerprint: 'fp-b' }),
      ],
    });
    const all = store.listForAgent('agent-z');
    assert.equal(all.length, 2);
    assert.equal(all.every((s) => s.status === 'active'), true);
  });

  it('separates lifecycle state across installed agent versions', () => {
    // Same source workaround, different installed agent ids
    // (two installed versions of the same spec).
    store.markActive({
      installedAgentId: 'agent.v1',
      workaround: makeWorkaround({ id: 'w-shared' }),
    });
    store.markActive({
      installedAgentId: 'agent.v2',
      workaround: makeWorkaround({ id: 'w-shared' }),
    });
    store.markResolved({ installedAgentId: 'agent.v1', workaroundId: 'w-shared' });

    const v1 = store.getOperationalState({
      installedAgentId: 'agent.v1',
      workaroundId: 'w-shared',
    });
    const v2 = store.getOperationalState({
      installedAgentId: 'agent.v2',
      workaroundId: 'w-shared',
    });
    assert.equal(v1?.status, 'resolved');
    assert.equal(v2?.status, 'active');
  });

  it('setPatchContext overrides the stored context', () => {
    store.markActive({
      installedAgentId: 'agent-pc',
      workaround: makeWorkaround(),
    });
    const ok = store.setPatchContext({
      installedAgentId: 'agent-pc',
      workaroundId: 'w-1',
      patchContext: {
        fingerprint: 'fp-1',
        reasoning: 'new context',
        relevantFiles: ['src/slots/foo.ts'],
      },
    });
    assert.equal(ok, true);
    const state = store.getOperationalState({
      installedAgentId: 'agent-pc',
      workaroundId: 'w-1',
    });
    assert.equal(state?.patchContext?.reasoning, 'new context');
  });
});
