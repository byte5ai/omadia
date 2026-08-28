import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryGrantStore, RoleSourceRegistry, makePrincipal } from '@omadia/channel-sdk';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type { Sandbox, SandboxBackend } from '../../packages/harness-sandbox/src/sandbox.js';
import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';
import type { PublishRuntime } from '../../packages/harness-publish/src/publish.js';
import { publishCapability } from '../../packages/harness-orchestrator/src/tools/publishAccess.js';
import {
  createGrantCheckedPublishHandler,
  createGrantCheckedPublishRollbackHandler,
} from '../../packages/harness-orchestrator/src/tools/publishGrantedTools.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

/**
 * Issue #581 P3 — the grant-checked tool wrappers, end to end: a real
 * `InMemoryPublishStore` + `InMemoryGrantStore` + `RoleSourceRegistry`,
 * exercised through the ACTUAL native-tool handler shape (a string in,
 * a string out), the same as `publishTool.test.ts`/`publishRollbackTool.test.ts`.
 * The refusal string is asserted explicitly — a silent no-op would pass a
 * looser "did not throw" check but fail this one.
 */
class StubBackend implements SandboxBackend {
  readonly provisionCalls: Array<{ scopeKey: string }> = [];
  async provision(args: { scopeKey: string }): Promise<Sandbox> {
    this.provisionCalls.push({ scopeKey: args.scopeKey });
    return {
      id: 'stub-sandbox',
      scopeKey: args.scopeKey,
      profile: resolveAgentComputerProfile(),
      async run() {
        throw new Error('not used');
      },
      async read(relativePath: string) {
        return relativePath === 'server.js' ? { ok: true as const, content: 'listen()' } : { ok: false as const, reason: 'not_found' as const, detail: 'x' };
      },
      async list(relativePath: string) {
        return relativePath === '.' || relativePath === ''
          ? { ok: true as const, entries: [{ name: 'server.js', kind: 'file' as const }] }
          : { ok: false as const, reason: 'not_found' as const, detail: 'x' };
      },
      async write() {
        throw new Error('not used');
      },
      async teardown() {
        /* no-op */
      },
    };
  }
}

function spyRuntime(): PublishRuntime & { readonly deployCalls: unknown[] } {
  const deployCalls: unknown[] = [];
  return {
    deployCalls,
    async deploy(args) {
      deployCalls.push(args);
    },
  };
}

function runInTurn<T>(sessionScope: string | undefined, fn: () => Promise<T>): Promise<T> {
  return turnContext.run({ turnId: 'turn-1', turnDate: '2026-08-20', ...(sessionScope !== undefined ? { sessionScope } : {}) }, fn);
}

async function seededStore(ownerScopeKey: string): Promise<InMemoryPublishStore> {
  const store = new InMemoryPublishStore();
  await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h1', sourceScopeKey: ownerScopeKey, now: new Date() });
  await store.setPointer('todo-app', 1, new Date());
  return store;
}

const PUBLISH_INPUT = { appId: 'todo-app', name: 'Todo', dir: '.', entrypoint: 'server.js' };

describe('createGrantCheckedPublishHandler', () => {
  it('the owner can republish its OWN app with zero grants configured — sharing cannot lock out the owner', async () => {
    const store = await seededStore('personal:owner');
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishHandler({
      sandboxBackend: backend,
      runtime,
      store,
      sharing: { grants, roles },
    });
    const raw = await runInTurn('personal:owner', () => handler(PUBLISH_INPUT));
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, 2);
    assert.equal(runtime.deployCalls.length, 1);
  });

  it('DENIAL: a non-owner scope with no grant is refused, with an explicit refusal string — never a silent no-op', async () => {
    const store = await seededStore('personal:owner');
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishHandler({
      sandboxBackend: backend,
      runtime,
      store,
      sharing: { grants, roles },
    });
    const result = await runInTurn('personal:stranger', () => handler(PUBLISH_INPUT));
    assert.match(result, /^Error: publish — refused:/);
    assert.match(result, /does not own app 'todo-app'/);
    assert.equal(backend.provisionCalls.length, 0, 'a denied publish must never touch the sandbox');
    assert.equal(runtime.deployCalls.length, 0, 'a denied publish must never deploy');
    assert.equal((await store.getVersion('todo-app', 2)), undefined, 'no new version was created');
  });

  it('a scope with a write grant CAN publish a new version of someone else\'s app', async () => {
    const store = await seededStore('personal:owner');
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const grants = new InMemoryGrantStore();
    grants.grantToPrincipal(makePrincipal('user', 'collaborator')!, publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishHandler({
      sandboxBackend: backend,
      runtime,
      store,
      sharing: { grants, roles },
    });
    const raw = await runInTurn('personal:collaborator', () => handler(PUBLISH_INPUT));
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, 2);
  });

  it('anyone may publish a brand-new appId — establishing ownership, not a lock-out', async () => {
    const store = new InMemoryPublishStore();
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishHandler({
      sandboxBackend: backend,
      runtime,
      store,
      sharing: { grants, roles },
    });
    const raw = await runInTurn('personal:first-timer', () => handler(PUBLISH_INPUT));
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, 1);
  });

  it('malformed input still reaches the inner handler\'s own validation error, not a grant-check message', async () => {
    const store = await seededStore('personal:owner');
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishHandler({ sandboxBackend: backend, runtime, store, sharing: { grants, roles } });
    const result = await runInTurn('personal:stranger', () => handler({ name: 'no appId at all' }));
    assert.match(result, /^Error: invalid publish input/);
  });
});

describe('createGrantCheckedPublishRollbackHandler', () => {
  it('the owner can roll back its OWN app with zero grants configured', async () => {
    const store = await seededStore('personal:owner');
    await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h2', sourceScopeKey: 'personal:owner', now: new Date() });
    await store.setPointer('todo-app', 2, new Date());
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishRollbackHandler({ store, sharing: { grants, roles } });
    const raw = await runInTurn('personal:owner', () => handler({ appId: 'todo-app', version: 1 }));
    const parsed = JSON.parse(raw) as { currentVersion: number };
    assert.equal(parsed.currentVersion, 1);
  });

  it('DENIAL: a non-owner scope with no grant is refused rollback, with an explicit refusal — the pointer never moves', async () => {
    const store = await seededStore('personal:owner');
    await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h2', sourceScopeKey: 'personal:owner', now: new Date() });
    await store.setPointer('todo-app', 2, new Date());
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishRollbackHandler({ store, sharing: { grants, roles } });
    const result = await runInTurn('personal:stranger', () => handler({ appId: 'todo-app', version: 1 }));
    assert.match(result, /^Error: publish_rollback — refused:/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2, 'a denied rollback must never move the pointer');
  });

  it('a scope with a write grant CAN roll back someone else\'s app', async () => {
    const store = await seededStore('personal:owner');
    await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h2', sourceScopeKey: 'personal:owner', now: new Date() });
    await store.setPointer('todo-app', 2, new Date());
    const grants = new InMemoryGrantStore();
    grants.grantToPrincipal(makePrincipal('user', 'collaborator')!, publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishRollbackHandler({ store, sharing: { grants, roles } });
    const raw = await runInTurn('personal:collaborator', () => handler({ appId: 'todo-app', version: 1 }));
    const parsed = JSON.parse(raw) as { currentVersion: number };
    assert.equal(parsed.currentVersion, 1);
  });

  it('a READ grant is not enough to roll back — rollback needs write', async () => {
    const store = await seededStore('personal:owner');
    await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h2', sourceScopeKey: 'personal:owner', now: new Date() });
    await store.setPointer('todo-app', 2, new Date());
    const grants = new InMemoryGrantStore();
    grants.grantToPrincipal(makePrincipal('user', 'collaborator')!, publishCapability('read', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const handler = createGrantCheckedPublishRollbackHandler({ store, sharing: { grants, roles } });
    const result = await runInTurn('personal:collaborator', () => handler({ appId: 'todo-app', version: 1 }));
    assert.match(result, /^Error: publish_rollback — refused:/);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 2);
  });
});
