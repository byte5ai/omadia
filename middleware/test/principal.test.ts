/**
 * #333 Phase 1 — `Principal`.
 *
 * The assertions that matter here are the ones covering the two ways this type
 * could be quietly wrong:
 *
 *  1. **The two kinds canonicalize differently** (user: trim+lowercase, role:
 *     trim only). Collapsing them is a silent routing bug in either direction.
 *  2. **A reference may contain colons**, because `coreApi.resolveIdentity`
 *     builds `` `${kind}:${id}` `` platform ids. Parsing must split on the
 *     first separator only.
 *
 * Plus a drift guard: Conductor's `canonicalizePrincipalId` and the SDK rule
 * must stay byte-identical, since the SQL that decides whether a reminder
 * reaches a person is a case-sensitive `=`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRINCIPAL_KINDS,
  canonicalizePrincipalRef,
  formatPrincipal,
  makePrincipal,
  parsePrincipal,
  principalRef,
  principalsEqual,
  type Principal,
} from '../packages/harness-channel-sdk/src/principal.js';
import { canonicalizePrincipalId } from '../src/conductor/principalId.js';

describe('canonicalization is asymmetric by kind, and that is deliberate', () => {
  it('user ids fold case, because the binding match is a case-sensitive =', () => {
    assert.equal(canonicalizePrincipalRef('user', '  Jane@Co.COM '), 'jane@co.com');
  });

  it('role keys keep their case, because createRole writes them verbatim', () => {
    // Lowercasing here would stop matching every mixed-case row already in a
    // live deployment's `conductor_roles` table.
    assert.equal(canonicalizePrincipalRef('role', '  Head-Of-Sales '), 'Head-Of-Sales');
  });

  it('the two rules actually differ for the same input', () => {
    const raw = 'Approver';
    assert.notEqual(canonicalizePrincipalRef('user', raw), canonicalizePrincipalRef('role', raw));
  });
});

describe('makePrincipal', () => {
  it('canonicalizes per kind', () => {
    assert.deepEqual(makePrincipal('user', ' A@B.COM '), { kind: 'user', userId: 'a@b.com' });
    assert.deepEqual(makePrincipal('role', ' Approver '), { kind: 'role', roleKey: 'Approver' });
  });

  it('refuses an empty reference rather than minting an unmatchable principal', () => {
    assert.equal(makePrincipal('user', ''), undefined);
    assert.equal(makePrincipal('user', '   '), undefined);
    assert.equal(makePrincipal('role', '\t'), undefined);
  });
});

describe('parsePrincipal', () => {
  it('parses both kinds', () => {
    assert.deepEqual(parsePrincipal('user:jane@co.com'), { kind: 'user', userId: 'jane@co.com' });
    assert.deepEqual(parsePrincipal('role:Approver'), { kind: 'role', roleKey: 'Approver' });
  });

  it('splits on the FIRST colon — a platform id like `user:teams:<oid>` survives whole', () => {
    // `coreApi.resolveIdentity` builds `${ref.kind}:${ref.id}`, so this is a
    // real value, not a synthetic edge case. A naive split(':') truncates it.
    const parsed = parsePrincipal('user:teams:29:1a2b3c');
    assert.deepEqual(parsed, { kind: 'user', userId: 'teams:29:1a2b3c' });
  });

  it('round-trips through formatPrincipal', () => {
    for (const wire of ['user:teams:29:1a2b3c', 'role:Head-Of-Sales', 'user:jane@co.com']) {
      const parsed = parsePrincipal(wire);
      assert.ok(parsed, wire);
      assert.equal(formatPrincipal(parsed), wire);
    }
  });

  it('returns undefined — never a user — for anything unparseable', () => {
    // An unrecognised prefix falling back to `user` would route an approval to
    // a person who does not exist.
    for (const bad of [undefined, '', '   ', 'jane@co.com', 'group:eng', ':jane', 'user:', 'user:   ']) {
      assert.equal(parsePrincipal(bad), undefined, JSON.stringify(bad));
    }
  });

  it('canonicalizes what it parses', () => {
    assert.deepEqual(parsePrincipal('  user:Jane@CO.com '), { kind: 'user', userId: 'jane@co.com' });
  });
});

describe('principalsEqual', () => {
  it('same kind + same ref is equal', () => {
    assert.ok(principalsEqual({ kind: 'user', userId: 'a' }, { kind: 'user', userId: 'a' }));
  });

  it('a role is never a user, even spelled identically', () => {
    // `role:` is a late-bound indirection resolved through the role resolver;
    // treating it as the person of the same name skips that expansion.
    const asUser: Principal = { kind: 'user', userId: 'approver' };
    const asRole: Principal = { kind: 'role', roleKey: 'approver' };
    assert.equal(principalsEqual(asUser, asRole), false);
  });
});

describe('principalRef', () => {
  it('reads the kind-appropriate field', () => {
    assert.equal(principalRef({ kind: 'user', userId: 'u1' }), 'u1');
    assert.equal(principalRef({ kind: 'role', roleKey: 'r1' }), 'r1');
  });
});

describe('the kind list matches the Conductor schema constraint', () => {
  it('is exactly the two kinds `principal_kind IN (user, role)` allows', () => {
    // `conductor/migrations/0001_conductor.sql:77`. A third kind added here
    // without a migration would be rejected by the database at write time.
    assert.deepEqual([...PRINCIPAL_KINDS].sort(), ['role', 'user']);
  });
});

describe('drift guard — Conductor delegates to the SDK rule', () => {
  it('canonicalizePrincipalId is byte-identical to the user rule', () => {
    // Two independent implementations of "canonical" drifting apart
    // reintroduces exactly the case-sensitive miss both exist to prevent.
    for (const raw of ['  Jane@Co.COM ', 'ALREADY-LOWER', 'a1b2-C3D4', '', '   ', 'teams:29:1a2b']) {
      assert.equal(canonicalizePrincipalId(raw), canonicalizePrincipalRef('user', raw), JSON.stringify(raw));
    }
  });
});
