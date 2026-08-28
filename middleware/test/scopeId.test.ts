import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  SHARED_SCOPE_TOKENS,
  SYSTEM_SCOPE_ORIGINS,
  formatSessionScope,
  parseSessionScope,
  scopeGraphKey,
  type ScopeId,
} from '@omadia/channel-sdk';

/**
 * Compile-time guard: every variant of the union must be constructible and
 * formattable here. If a variant is added without a round-trip case, this
 * array stops type-checking before the runtime suite even runs.
 */
const EVERY_KIND: readonly ScopeId[] = [
  { kind: 'personal', userId: 'u1' },
  { kind: 'conversation', conversationId: 'c1' },
  { kind: 'conversation', channelId: 'teams', conversationId: 'c1' },
  { kind: 'group', groupRef: 'g1' },
  { kind: 'org', orgId: 'o1' },
  { kind: 'system', origin: 'routine', id: 'r1' },
  { kind: 'unscoped', reason: 'absent' },
  { kind: 'unscoped', reason: 'shared', token: 'http-default' },
];

// #575 Phase 1 — the ScopeId type and its migration adapter.
//
// `parseSessionScope` is deliberately a MIGRATION adapter, not a general
// parser: its contract is that it classifies every value the tree actually
// produces (measured in specs/575-scope-and-identity-foundation/spec.md §2.2)
// while round-tripping byte-identically, so introducing the type cannot move
// a single existing scope string.

describe('#575 parseSessionScope — the values the tree actually produces', () => {
  it('classifies an absent scope as unscoped/absent, not as a shared bucket', () => {
    for (const raw of [undefined, '', '   ', '\t\n']) {
      const scope = parseSessionScope(raw);
      assert.deepEqual(scope, { kind: 'unscoped', reason: 'absent' }, `raw=${JSON.stringify(raw)}`);
    }
  });

  it("classifies 'http-default' as unscoped/shared — the #445 cross-user hole, as a type", () => {
    // routes/chat.ts:54 returns this literal for every anonymous caller.
    assert.deepEqual(parseSessionScope('http-default'), {
      kind: 'unscoped',
      reason: 'shared',
      token: 'http-default',
    });
  });

  it("classifies 'teams-unknown' as unscoped/shared — it has a LIVE producer", () => {
    // omadia-byte5-plugins channel-teams/src/teamsBot.ts:440-441 —
    // `conversation?.id ?? 'unknown'` + `teams-${conversationId}`.
    assert.deepEqual(parseSessionScope('teams-unknown'), {
      kind: 'unscoped',
      reason: 'shared',
      token: 'teams-unknown',
    });
  });

  it('classifies every machine scope as system, with its origin recovered', () => {
    assert.deepEqual(parseSessionScope('routine:abc'), {
      kind: 'system',
      origin: 'routine',
      id: 'abc',
    });
    assert.deepEqual(parseSessionScope('schedule:s1'), {
      kind: 'system',
      origin: 'schedule',
      id: 's1',
    });
    // conductor:<runId>:<stepId> — the id keeps everything after the FIRST colon.
    assert.deepEqual(parseSessionScope('conductor:run1:step2'), {
      kind: 'system',
      origin: 'conductor',
      id: 'run1:step2',
    });
  });

  // The two origins LOOK like an overlapping-prefix hazard. They are not,
  // because the match carries a trailing colon and `conductor-builder:x` does
  // not start with `conductor:`. Verified by mutation: reordering the origin
  // array does not break this; dropping the colon from the match does.
  it("keeps 'conductor-builder' distinct from 'conductor'", () => {
    const scope = parseSessionScope('conductor-builder:slug:uuid');
    assert.equal(scope.kind, 'system');
    assert.equal(scope.kind === 'system' && scope.origin, 'conductor-builder');
    assert.equal(scope.kind === 'system' && scope.id, 'slug:uuid');
  });

  it('splits the CoreApi `channelId::conversationId` form on the FIRST separator', () => {
    assert.deepEqual(parseSessionScope('teams::conv::with::colons'), {
      kind: 'conversation',
      channelId: 'teams',
      conversationId: 'conv::with::colons',
    });
  });

  it('leaves an unrecognised scope opaque rather than guessing its channel', () => {
    // `teams-<conv>` and `telegram:<id>` are produced by the private plugins.
    // Phase 1 must NOT re-spell them — that would move their graph partition.
    // D7 migrates the PRODUCERS; the adapter stays conservative.
    for (const raw of ['teams-19:abc@thread.tacv2', 'telegram:12345', 'my-chat-tab', 'http-cli']) {
      const scope = parseSessionScope(raw);
      assert.deepEqual(scope, { kind: 'conversation', conversationId: raw }, `raw=${raw}`);
    }
  });

  it('recognises the canonical personal/group/org spellings', () => {
    assert.deepEqual(parseSessionScope('personal:u1'), { kind: 'personal', userId: 'u1' });
    assert.deepEqual(parseSessionScope('group:g1'), { kind: 'group', groupRef: 'g1' });
    assert.deepEqual(parseSessionScope('org:o1'), { kind: 'org', orgId: 'o1' });
  });

  it('exposes the shared tokens and system origins it recognises', () => {
    assert.ok(SHARED_SCOPE_TOKENS.has('http-default'));
    assert.ok(SHARED_SCOPE_TOKENS.has('teams-unknown'));
    assert.ok(SHARED_SCOPE_TOKENS.has('unknown'));
    assert.deepEqual([...SYSTEM_SCOPE_ORIGINS].sort(), [
      'conductor',
      'conductor-builder',
      'routine',
      'schedule',
    ]);
  });
});

describe('#575 formatSessionScope — round-trips every produced value byte-identically', () => {
  // Introducing the type must not move a single scope string on the wire.
  const PRODUCED_BY_THE_TREE: readonly string[] = [
    'http-default',
    'http-cli-john',
    'teams-unknown',
    'unknown',
    'my-session-tab',
    'teams::19:abc@thread.tacv2',
    'teams-19:abc@thread.tacv2',
    'telegram:12345',
    'routine:daily-digest',
    'schedule:sched-7',
    'conductor:run1:step2',
    'conductor-builder:my-agent:0f8c',
    'personal:u1',
    'group:g1',
    'org:o1',
    'a::',
  ];

  for (const raw of PRODUCED_BY_THE_TREE) {
    it(`round-trips ${JSON.stringify(raw)}`, () => {
      assert.equal(formatSessionScope(parseSessionScope(raw)), raw);
    });
  }

  it('formats an absent scope back to the empty string', () => {
    assert.equal(formatSessionScope({ kind: 'unscoped', reason: 'absent' }), '');
  });

  it('round-trips every variant of the union, not just the observed strings', () => {
    for (const scope of EVERY_KIND) {
      const wire = formatSessionScope(scope);
      assert.deepEqual(parseSessionScope(wire), scope, `variant ${scope.kind} wire=${wire}`);
    }
  });

  it('re-parses to an identical ScopeId (parse ∘ format ∘ parse is stable)', () => {
    for (const raw of PRODUCED_BY_THE_TREE) {
      const once = parseSessionScope(raw);
      const twice = parseSessionScope(formatSessionScope(once));
      assert.deepEqual(twice, once, `raw=${raw}`);
    }
  });
});

describe('#575 D3 — scopeGraphKey is injective where sanitizeScope was not', () => {
  it('leaves an already-safe scope byte-identical, so its partition is preserved', () => {
    // These match /^[a-z0-9_-]{1,80}$/ and so were never lossy. Existing
    // deployments must keep reading the same graph partition for them.
    for (const raw of ['http-default', 'teams-unknown', 'unknown', 'my-session-tab']) {
      assert.equal(scopeGraphKey(raw), raw, `raw=${raw}`);
    }
  });

  it('separates the scopes that sanitizeScope collapsed into one key', () => {
    // The spec §2.3 collision: ':' and '::' both became '-'.
    const collided = ['teams::c1', 'teams:c1', 'teams-c1'];
    const keys = collided.map(scopeGraphKey);
    assert.equal(new Set(keys).size, collided.length, `keys=${JSON.stringify(keys)}`);
  });

  it('separates scopes that differed only by case', () => {
    const keys = ['Teams::C1', 'teams::c1'].map(scopeGraphKey);
    assert.notEqual(keys[0], keys[1]);
  });

  it('separates scopes that agree on their first 80 sanitized characters', () => {
    const prefix = 'x'.repeat(90);
    const keys = [`${prefix}alpha`, `${prefix}beta`].map(scopeGraphKey);
    assert.notEqual(keys[0], keys[1]);
  });

  it('always emits a graph-safe key of at most 80 characters', () => {
    const samples = [
      'teams::19:AbC@thread.tacv2',
      'x'.repeat(500),
      'conductor:run1:step2',
      'ÄÖÜ-umlauts-and-emoji-🙂',
      '///',
    ];
    for (const raw of samples) {
      const key = scopeGraphKey(raw);
      assert.match(key, /^[a-z0-9_-]{1,80}$/, `raw=${raw} key=${key}`);
    }
  });

  it("maps a genuinely EMPTY scope to 'unscoped', exactly as sanitizeScope did", () => {
    assert.equal(scopeGraphKey(''), 'unscoped');
    assert.equal(scopeGraphKey('   '), 'unscoped');
  });

  it("does NOT collapse a non-empty unsafe scope onto 'unscoped'", () => {
    // sanitizeScope mapped '///' to 'unscoped' — indistinguishable from a
    // turn that carried no scope at all. That conflation is the bug.
    assert.notEqual(scopeGraphKey('///'), 'unscoped');
    assert.notEqual(scopeGraphKey('///'), scopeGraphKey('***'));
  });

  it('is deterministic', () => {
    const raw = 'teams::19:abc@thread.tacv2';
    assert.equal(scopeGraphKey(raw), scopeGraphKey(raw));
  });
});
