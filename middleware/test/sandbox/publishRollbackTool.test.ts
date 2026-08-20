import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { defaultCommandPolicy, type CommandPolicy } from '../../packages/harness-channel-sdk/src/commandPolicy.js';
import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';
import { createPublishRollbackHandler } from '../../packages/harness-orchestrator/src/tools/publishRollbackTool.js';
import { getCommandPolicyMetrics, resetCommandPolicyMetrics } from '../../packages/harness-orchestrator/src/commandPolicyMetrics.js';

/** Issue #581 P2 — `publish_rollback` tool tests. */

async function seeded(): Promise<InMemoryPublishStore> {
  const store = new InMemoryPublishStore();
  await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() });
  await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'x.js', dirHash: 'h2', sourceScopeKey: 's', now: new Date() });
  await store.setPointer('todo-app', 2, new Date());
  return store;
}

beforeEach(() => {
  resetCommandPolicyMetrics();
});

describe('publish_rollback tool — command-policy check runs before touching the store', () => {
  it('denies when the policy has a matching rule for the synthetic "rollback <appId>" pseudo-command', async () => {
    const store = await seeded();
    const policy: CommandPolicy = {
      ...defaultCommandPolicy(),
      scopeRules: [{ id: 'scope.deny-rollback', decision: 'deny', reason: 'rollbacks frozen', match: { kind: 'commandFlag', name: 'rollback' } }],
    };
    const handler = createPublishRollbackHandler({ store, resolveCommandPolicy: () => policy });
    const result = await handler({ appId: 'todo-app', version: 1 });
    assert.match(result, /^Error: publish_rollback — refused by the command policy/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2, 'the pointer must not move');
    assert.equal(getCommandPolicyMetrics().denied, 1);
  });

  it('refuses a require_approval decision without moving the pointer', async () => {
    const store = await seeded();
    const policy: CommandPolicy = {
      ...defaultCommandPolicy(),
      scopeRules: [{ id: 'scope.approve-rollback', decision: 'require_approval', reason: 'needs review', match: { kind: 'commandFlag', name: 'rollback' } }],
    };
    const handler = createPublishRollbackHandler({ store, resolveCommandPolicy: () => policy });
    const result = await handler({ appId: 'todo-app', version: 1 });
    assert.match(result, /requires human approval.*not yet available/);
    assert.match(result, /It was NOT rolled back/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2);
  });

  it('fails CLOSED when the command policy resolver throws', async () => {
    const store = await seeded();
    const handler = createPublishRollbackHandler({
      store,
      resolveCommandPolicy: () => {
        throw new Error('policy backend unreachable');
      },
    });
    const result = await handler({ appId: 'todo-app', version: 1 });
    assert.match(result, /command policy could not be resolved; refusing to run \(fail-closed\)/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2);
  });

  it('rejects malformed input before any policy check', async () => {
    const store = await seeded();
    const handler = createPublishRollbackHandler({ store });
    const result = await handler({ appId: 'todo-app' });
    assert.match(result, /^Error: invalid publish_rollback input/);
    assert.equal(getCommandPolicyMetrics().total, 0);
  });
});

describe('publish_rollback tool — a permitted rollback is a pointer flip', () => {
  it('flips the pointer to an earlier version and returns structured JSON', async () => {
    const store = await seeded();
    const handler = createPublishRollbackHandler({ store });
    const raw = await handler({ appId: 'todo-app', version: 1 });
    const parsed = JSON.parse(raw) as { appId: string; currentVersion: number; updatedAt: string };
    assert.equal(parsed.appId, 'todo-app');
    assert.equal(parsed.currentVersion, 1);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 1);
    assert.equal(getCommandPolicyMetrics().allowed, 1);
  });

  it('surfaces a rollback to a never-published version as a tool-result Error', async () => {
    const store = await seeded();
    const handler = createPublishRollbackHandler({ store });
    const result = await handler({ appId: 'todo-app', version: 99 });
    assert.match(result, /^Error: publish_rollback —/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2, 'a failed rollback must not move the pointer');
  });
});
