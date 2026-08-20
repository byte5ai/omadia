import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  InMemoryGrantStore,
  RoleSourceRegistry,
  type Principal,
  type RoleLookup,
  type RoleSource,
} from '@omadia/channel-sdk';

import {
  parseSharedSkillCapability,
  resolveSharedSkillIds,
  sharedSkillCapability,
  toSharedSkillIdsSet,
} from '../src/services/skillSharing.js';

const ALICE: Principal = { kind: 'user', userId: 'alice' };

describe('sharedSkillCapability / parseSharedSkillCapability', () => {
  it('round-trips a skill id through the capability string', () => {
    const cap = sharedSkillCapability('skill-123');
    assert.equal(cap, 'skill:read:skill-123');
    assert.equal(parseSharedSkillCapability(cap), 'skill-123');
  });

  it('returns undefined for a capability that is not a skill-share', () => {
    assert.equal(parseSharedSkillCapability('mcp.web-search'), undefined);
    assert.equal(parseSharedSkillCapability('skill:write:x'), undefined);
  });

  it('returns undefined for an empty id (malformed capability, never a fake empty-string id)', () => {
    assert.equal(parseSharedSkillCapability('skill:read:'), undefined);
  });
});

describe('resolveSharedSkillIds', () => {
  it('resolves ids granted directly to the principal', async () => {
    const grants = new InMemoryGrantStore().grantToPrincipal(
      ALICE,
      sharedSkillCapability('skill-a'),
      sharedSkillCapability('skill-b'),
    );
    const roles = new RoleSourceRegistry();
    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: true, ids: new Set(['skill-a', 'skill-b']) });
  });

  it('ignores non-skill capabilities granted alongside real ones', async () => {
    const grants = new InMemoryGrantStore().grantToPrincipal(
      ALICE,
      sharedSkillCapability('skill-a'),
      'mcp.web-search',
    );
    const roles = new RoleSourceRegistry();
    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: true, ids: new Set(['skill-a']) });
  });

  it('unions role grants with direct grants', async () => {
    const fakeSource: RoleSource = {
      id: 'test-source',
      displayName: 'Test',
      rolesFor: async (): Promise<RoleLookup> => ({ outcome: 'resolved', roles: ['editors'] }),
    };
    const roles = new RoleSourceRegistry();
    roles.register(fakeSource);

    const grants = new InMemoryGrantStore()
      .grantToPrincipal(ALICE, sharedSkillCapability('skill-a'))
      .grantToRole('editors', sharedSkillCapability('skill-b'));

    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: true, ids: new Set(['skill-a', 'skill-b']) });
  });

  it('a denial removes an otherwise-granted skill id', async () => {
    const grants = new InMemoryGrantStore()
      .grantToPrincipal(ALICE, sharedSkillCapability('skill-a'), sharedSkillCapability('skill-b'))
      .denyToPrincipal(ALICE, sharedSkillCapability('skill-b'));
    const roles = new RoleSourceRegistry();
    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: true, ids: new Set(['skill-a']) });
  });

  it('returns unresolved when a role source is partial (never silently empties the set)', async () => {
    const throwingSource: RoleSource = {
      id: 'broken-source',
      displayName: 'Broken',
      rolesFor: async (): Promise<RoleLookup> => {
        throw new Error('directory unreachable');
      },
    };
    const roles = new RoleSourceRegistry();
    roles.register(throwingSource);
    const grants = new InMemoryGrantStore().grantToPrincipal(ALICE, sharedSkillCapability('skill-a'));

    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: false, reason: 'unresolved' });
  });

  it('resolves to an empty set (not unresolved) when nothing is granted', async () => {
    const grants = new InMemoryGrantStore();
    const roles = new RoleSourceRegistry();
    const result = await resolveSharedSkillIds(ALICE, roles, grants);
    assert.deepEqual(result, { ok: true, ids: new Set() });
  });
});

describe('toSharedSkillIdsSet', () => {
  it('passes through the ids on a resolved result', () => {
    assert.deepEqual(toSharedSkillIdsSet({ ok: true, ids: new Set(['a']) }), new Set(['a']));
  });

  it('fails closed to an empty set on unresolved', () => {
    assert.deepEqual(toSharedSkillIdsSet({ ok: false, reason: 'unresolved' }), new Set());
  });
});
