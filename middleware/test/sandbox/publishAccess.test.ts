import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryGrantStore, RoleSourceRegistry, makePrincipal } from '@omadia/channel-sdk';
import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';
import {
  checkPublishAccess,
  createGrantCheckedResolveTarget,
  publishCapability,
} from '../../packages/harness-orchestrator/src/tools/publishAccess.js';

/**
 * Issue #581 P3 — `checkPublishAccess` / `createGrantCheckedResolveTarget`.
 * The DENIAL direction is the point: every test that grants something is
 * paired with one proving the absence of that grant refuses.
 */
async function seededStore(ownerScopeKey: string): Promise<InMemoryPublishStore> {
  const store = new InMemoryPublishStore();
  await store.createVersion({
    appId: 'todo-app',
    name: 'Todo',
    entrypoint: 'x.js',
    dirHash: 'h1',
    sourceScopeKey: ownerScopeKey,
    now: new Date(),
  });
  await store.setPointer('todo-app', 1, new Date());
  return store;
}

describe('checkPublishAccess — ownership', () => {
  it('the owner scope needs NO grant to write its own app', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore(); // deliberately empty — no grant configured anywhere
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:owner', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: true, reason: 'owner' });
  });

  it('the owner scope needs NO grant to read its own app', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:owner', capability: 'read' },
    );
    assert.deepEqual(decision, { allowed: true, reason: 'owner' });
  });

  it('a brand-new appId (no version 1 yet) is allowed unconditionally — establishing ownership', async () => {
    const store = new InMemoryPublishStore();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'fresh-app', callerScopeKey: 'personal:anyone', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: true, reason: 'unpublished' });
  });
});

describe('checkPublishAccess — DENIAL direction (no grant)', () => {
  it('a non-owner scope with NO grant is refused write access', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'no_grant' });
  });

  it('a non-owner scope with NO grant is refused read access', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'read' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'no_grant' });
  });

  it('a write grant does NOT imply read, and vice versa', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const strangerPrincipal = makePrincipal('user', 'stranger')!;
    grants.grantToPrincipal(strangerPrincipal, publishCapability('read', 'todo-app'));
    const roles = new RoleSourceRegistry();

    const readDecision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'read' },
    );
    assert.equal(readDecision.allowed, true);

    const writeDecision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'write' },
    );
    assert.deepEqual(writeDecision, { allowed: false, reason: 'no_grant' });
  });

  it('a grant for a DIFFERENT appId does not leak access to this one', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const strangerPrincipal = makePrincipal('user', 'stranger')!;
    grants.grantToPrincipal(strangerPrincipal, publishCapability('write', 'some-other-app'));
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'no_grant' });
  });

  it('a direct DENIAL beats a direct GRANT for the same capability', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const strangerPrincipal = makePrincipal('user', 'stranger')!;
    grants.grantToPrincipal(strangerPrincipal, publishCapability('write', 'todo-app'));
    grants.denyToPrincipal(strangerPrincipal, publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'denied' });
  });
});

describe('checkPublishAccess — a real grant permits the SHARED direction too', () => {
  it('a directly-granted write capability lets a non-owner scope redeploy', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const sharedPrincipal = makePrincipal('user', 'collaborator')!;
    grants.grantToPrincipal(sharedPrincipal, publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:collaborator', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: true, reason: 'granted' });
  });

  it('a role grant lets any holder of that role redeploy', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    grants.grantToRole('deployers', publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    roles.register({
      id: 'test-role-source',
      displayName: 'Test Role Source',
      rolesFor: async (principal) => ({
        outcome: 'resolved',
        roles: principal.kind === 'user' && principal.userId === 'collaborator' ? ['deployers'] : [],
      }),
    });
    const granted = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:collaborator', capability: 'write' },
    );
    assert.deepEqual(granted, { allowed: true, reason: 'granted' });

    const notInRole = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:stranger', capability: 'write' },
    );
    assert.deepEqual(notInRole, { allowed: false, reason: 'no_grant' });
  });
});

describe('checkPublishAccess — non-personal scopes cannot hold a share grant (fail closed)', () => {
  it('a conversation-scoped caller (no resolvable Principal) is denied even with a matching grant on file', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'conversation::abc123', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'principal_unresolvable' });
  });

  it('an unscoped caller is denied', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: '', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'principal_unresolvable' });
  });
});

describe('checkPublishAccess — fails CLOSED when the role lookup is partial', () => {
  it('an unavailable role source denies a non-owner, even though a direct grant alone would have sufficed', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const collaborator = makePrincipal('user', 'collaborator')!;
    grants.grantToPrincipal(collaborator, publishCapability('write', 'todo-app'));
    const roles = new RoleSourceRegistry();
    roles.register({
      id: 'flaky-role-source',
      displayName: 'Flaky Role Source',
      rolesFor: async () => {
        throw new Error('directory unreachable');
      },
    });
    const decision = await checkPublishAccess(
      { store, grants, roles },
      { appId: 'todo-app', callerScopeKey: 'personal:collaborator', capability: 'write' },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'grant_lookup_unresolved' });
  });
});

describe('createGrantCheckedResolveTarget — the gateway read-path', () => {
  function fakeRuntime(ports: Record<string, number>) {
    return {
      async portFor(appId: string, version: number) {
        return ports[`${appId}:${String(version)}`];
      },
    };
  }

  it('resolves the target for the owner without any grant', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const runtime = fakeRuntime({ 'todo-app:1': 54321 });
    const resolveTarget = createGrantCheckedResolveTarget({ store, grants, roles, runtime }, 'personal:owner');
    const target = await resolveTarget('todo-app');
    assert.deepEqual(target, { host: '127.0.0.1', port: 54321 });
  });

  it('DENIES resolution for a non-owner with no read grant — indistinguishable from not-found', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const runtime = fakeRuntime({ 'todo-app:1': 54321 });
    const resolveTarget = createGrantCheckedResolveTarget({ store, grants, roles, runtime }, 'personal:stranger');
    assert.equal(await resolveTarget('todo-app'), undefined);
  });

  it('resolves for a scope holding a read grant', async () => {
    const store = await seededStore('personal:owner');
    const grants = new InMemoryGrantStore();
    grants.grantToPrincipal(makePrincipal('user', 'collaborator')!, publishCapability('read', 'todo-app'));
    const roles = new RoleSourceRegistry();
    const runtime = fakeRuntime({ 'todo-app:1': 54321 });
    const resolveTarget = createGrantCheckedResolveTarget({ store, grants, roles, runtime }, 'personal:collaborator');
    const target = await resolveTarget('todo-app');
    assert.deepEqual(target, { host: '127.0.0.1', port: 54321 });
  });

  it('returns undefined for an app that was never published', async () => {
    const store = new InMemoryPublishStore();
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const runtime = fakeRuntime({});
    const resolveTarget = createGrantCheckedResolveTarget({ store, grants, roles, runtime }, 'personal:anyone');
    assert.equal(await resolveTarget('nonexistent-app'), undefined);
  });
});
