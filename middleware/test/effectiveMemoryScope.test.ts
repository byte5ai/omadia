/**
 * W5 memory-ACL — context-scoped agent memory (design #870).
 *
 * This file is the §8.1 unit matrix. It currently covers
 * `effectiveMemoryScope`: the per-turn intersection of the static agent scope
 * with the dynamic context axes.
 *
 * The function decides no path — it only names scopes — so every case here is a
 * pure table assertion on the emitted tokens. What is under test is the
 * SECURITY property, not a formatting one: an unrecognised turn must land on
 * row 1 of the §2 table (agent-private, no context tree), a recognised one must
 * lose write access to the agent tier, and neither may ever emit a token wider
 * than `core` + this agent's own tiers.
 *
 * Pollution guard (§8): every case builds its own inputs and its own log sink.
 * No module-level fixtures, no shared state, no env mutation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveMemoryScope,
  orchestratorMemoryScope,
  type MemoryAxes,
} from '../packages/harness-orchestrator/src/registry/scopedMemoryStore.js';

interface LogLine {
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

function sink(): { lines: LogLine[]; log: (msg: string, fields?: Record<string, unknown>) => void } {
  const lines: LogLine[] = [];
  return { lines, log: (msg, fields) => void lines.push({ msg, fields }) };
}

/** Row 1 of the §2 table — the fail-closed answer, in every shape it arrives in. */
function contextFreeAxes(): MemoryAxes {
  return { isContextFree: true, patterns: [] };
}

function channelAxes(ctxKey: string): MemoryAxes {
  return {
    isContextFree: false,
    patterns: [`channel:${ctxKey}:*`],
    narrowest: { axis: 'channel', ctxKey },
  };
}

// ---------------------------------------------------------------------------
// Golden comparison: the context-free branch is exactly today's behaviour.
// ---------------------------------------------------------------------------

test('context-free axes return byte-identical output to orchestratorMemoryScope', () => {
  // Arrange — the compat anchor is the whole point of the fail-closed branch:
  // a turn that names no context must behave as it does today, not merely
  // "similarly".
  for (const slug of ['public', 'hr-agent', 'a', 'agent_with_underscores']) {
    // Act
    const effective = effectiveMemoryScope(slug, contextFreeAxes());

    // Assert
    assert.deepStrictEqual(effective, orchestratorMemoryScope(slug));
    assert.deepStrictEqual(effective, ['core', `orchestrator:${slug}:*`]);
  }
});

test('context-free branch grants the agent tier read-WRITE (no ro: modifier)', () => {
  // Arrange / Act
  const scope = effectiveMemoryScope('public', contextFreeAxes());

  // Assert — operator UI / CLI turns must keep writing where they write today.
  assert.ok(scope.includes('orchestrator:public:*'));
  assert.ok(!scope.some((p) => p.startsWith('ro:')));
});

test('a context-free axes object cannot smuggle context patterns in', () => {
  // Arrange — a half-built or hostile axes: the flag says "no context", the
  // patterns say otherwise. The flag wins, because trusting the patterns here
  // would let a plugin open a tier it just declared unreachable.
  const axes: MemoryAxes = {
    isContextFree: true,
    patterns: ['team:teams~acme:*', 'channel:teams~c1:*'],
  };

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));
});

// ---------------------------------------------------------------------------
// Context turns: static ∩ dynamic.
// ---------------------------------------------------------------------------

test('a channel-context turn adds its tier and downgrades the agent tier to ro:', () => {
  // Arrange / Act
  const scope = effectiveMemoryScope('public', channelAxes('teams~c1'));

  // Assert — §4 step 7, verbatim.
  assert.deepStrictEqual(scope, [
    'ro:core',
    'ro:orchestrator:public:*',
    'channel:teams~c1:*',
  ]);
});

test('the agent tier is read-only from context turns — the bare token never appears', () => {
  // Arrange — this is the leak channel the design exists to close: if
  // `orchestrator:<slug>:*` survived without `ro:`, "note this globally" in
  // team A would be readable in team B on the next turn.
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['channel:teams~c1:*', 'team:teams~acme:*'],
    narrowest: { axis: 'channel', ctxKey: 'teams~c1' },
  };

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.ok(!scope.includes('orchestrator:public:*'));
  assert.ok(scope.includes('ro:orchestrator:public:*'));
});

test('team and channel tiers keep the narrowest-first order the axes gave them', () => {
  // Arrange — the binder reads the default write target off the first context
  // pattern, so the order is load-bearing rather than cosmetic.
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['channel:teams~c1:*', 'team:teams~acme:*'],
    narrowest: { axis: 'channel', ctxKey: 'teams~c1' },
  };

  // Act
  const scope = effectiveMemoryScope('hr', axes);

  // Assert
  assert.deepStrictEqual(scope, [
    'ro:core',
    'ro:orchestrator:hr:*',
    'channel:teams~c1:*',
    'team:teams~acme:*',
  ]);
});

test('a personal-chat turn reaches the user tier and nothing else', () => {
  // Arrange
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['user:telegram~4711:*'],
    narrowest: { axis: 'user', ctxKey: 'telegram~4711' },
  };

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, [
    'ro:core',
    'ro:orchestrator:public:*',
    'user:telegram~4711:*',
  ]);
});

test('core stays READABLE in every branch, but writable only context-free', () => {
  // Shared kernel/seed content stays reachable across the context split (§2,
  // §7) — but only for reading from a context turn. The shared trees are the
  // one model-facing surface two contexts address by the same path, so a
  // writable `core` would be a one-line bypass of the whole ACL: A writes
  // `/memories/core/notes.md`, B reads it. Writes to the shared trees stay a
  // context-FREE privilege; knowledge leaves a context via promote (decision 2).
  assert.ok(effectiveMemoryScope('public', contextFreeAxes()).includes('core'));
  assert.ok(effectiveMemoryScope('public', channelAxes('teams~c1')).includes('ro:core'));
  assert.ok(
    effectiveMemoryScope('public', channelAxes('teams~c1'), {
      mode: 'enforce-strict',
    }).includes('ro:core'),
  );
  // …and the bare, writable token never appears on a context turn.
  for (const mode of ['enforce', 'enforce-strict'] as const) {
    assert.ok(
      !effectiveMemoryScope('public', channelAxes('teams~c1'), { mode }).includes('core'),
    );
  }
});

test('duplicate context patterns collapse so the scope string stays canonical', () => {
  // Arrange — the binder caches its per-context stack under the canonical
  // scope string; two spellings of one scope would be two cache entries.
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['channel:teams~c1:*', 'channel:teams~c1:*', 'team:teams~acme:*'],
  };

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, [
    'ro:core',
    'ro:orchestrator:public:*',
    'channel:teams~c1:*',
    'team:teams~acme:*',
  ]);
});

// ---------------------------------------------------------------------------
// Fail-closed: nothing a plugin sends may widen the scope.
// ---------------------------------------------------------------------------

test('patterns outside the three context tiers are dropped and logged', () => {
  // Arrange — `axes.patterns` crosses a package boundary from an independently
  // versioned channel plugin. Each of these would WIDEN the turn if it were
  // passed through: another agent's tree, the shared namespace as a write
  // target, a raw path, a key smuggling a `:` to re-parse as another tier.
  const widening = [
    'core',
    'orchestrator:other-agent:*',
    'agent:other:*',
    'session:*',
    '/memories/*',
    '/memories/core/rules.md',
    'team:teams:acme:*',
    'team::*',
    'channel:teams~c1:**',
    'channel:teams~c1',
    '',
  ];

  for (const bad of widening) {
    const { lines, log } = sink();
    const axes: MemoryAxes = {
      isContextFree: false,
      patterns: ['channel:teams~c1:*', bad],
    };

    // Act
    const scope = effectiveMemoryScope('public', axes, { log });

    // Assert — the exact shape is the real check. (Note `'core'` is in the
    // output either way: it is granted by the STATIC scope, never by an axis.
    // That is precisely why an axis may not be trusted to name it.)
    assert.deepStrictEqual(
      scope,
      ['ro:core', 'ro:orchestrator:public:*', 'channel:teams~c1:*'],
      `pattern "${bad}" must not survive`,
    );
    assert.equal(lines.length, 1, `pattern "${bad}" must be logged`);
    assert.match(lines[0]!.msg, /dropping non-context axis pattern/);
    assert.equal(lines[0]!.fields?.pattern, bad);
  }
});

test('a context turn whose patterns are all unusable falls back to row 1', () => {
  // Arrange — indistinguishable from a turn that named no tier at all, so it
  // must get the same answer rather than an empty (or partial) context scope.
  const axes: MemoryAxes = { isContextFree: false, patterns: ['core', '/memories/*'] };

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));
});

test('a context turn with an empty pattern list falls back to row 1', () => {
  // Arrange / Act
  const scope = effectiveMemoryScope('public', { isContextFree: false, patterns: [] });

  // Assert
  assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));
});

test('malformed axes never throw on the message path', () => {
  // Arrange — a bug in a channel plugin must not drop a user's turn. Each of
  // these is a shape the type system forbids but the wire allows.
  const malformed: unknown[] = [
    undefined,
    null,
    {},
    { isContextFree: false },
    { isContextFree: false, patterns: null },
    { isContextFree: false, patterns: ['channel:teams~c1:*', 42, undefined, null, {}] },
    { patterns: ['channel:teams~c1:*'] },
    { isContextFree: 'no', patterns: ['channel:teams~c1:*'] },
  ];

  for (const axes of malformed) {
    const { log } = sink();

    // Act — must not throw.
    const scope = effectiveMemoryScope('public', axes as MemoryAxes, { log });

    // Assert — and must never be wider than the agent's own scope.
    assert.ok(Array.isArray(scope));
    assert.ok(!scope.some((p) => p.includes('other')));
    for (const token of scope) {
      assert.ok(
        token === 'core' ||
          token === 'ro:core' ||
          token === 'orchestrator:public:*' ||
          token === 'ro:orchestrator:public:*' ||
          /^(?:team|channel|user):[^:]+:\*$/.test(token),
        `unexpected token "${token}"`,
      );
    }
  }
});

test('a truthy-but-not-false isContextFree is treated as context-free', () => {
  // Arrange — omission must fail closed: only an explicit `false` opens a tier.
  const axes = { patterns: ['channel:teams~c1:*'] } as unknown as MemoryAxes;

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));
});

test('one agent never receives another agent slug in its scope', () => {
  // Arrange
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['team:teams~acme:*'],
    narrowest: { axis: 'team', ctxKey: 'teams~acme' },
  };

  // Act
  const a = effectiveMemoryScope('agent-a', axes);
  const b = effectiveMemoryScope('agent-b', axes);

  // Assert — the isolation axis is agent × context: the same team on two
  // agents yields two scopes that share only `core` and the team tier.
  assert.ok(a.includes('ro:orchestrator:agent-a:*'));
  assert.ok(!a.some((p) => p.includes('agent-b')));
  assert.ok(b.includes('ro:orchestrator:agent-b:*'));
  assert.ok(!b.some((p) => p.includes('agent-a')));
});

test('the returned scope is a fresh array — callers cannot mutate a shared one', () => {
  // Arrange / Act
  const first = effectiveMemoryScope('public', channelAxes('teams~c1')) as string[];
  first.push('core');

  // Assert
  assert.deepStrictEqual(effectiveMemoryScope('public', channelAxes('teams~c1')), [
    'ro:core',
    'ro:orchestrator:public:*',
    'channel:teams~c1:*',
  ]);
});

// ---------------------------------------------------------------------------
// enforce-strict (design §10 Q3, settled): full quarantine of legacy knowledge.
// ---------------------------------------------------------------------------

test('enforce-strict drops the agent tier from context turns entirely', () => {
  // Arrange
  const axes: MemoryAxes = {
    isContextFree: false,
    patterns: ['channel:teams~c1:*', 'team:teams~acme:*'],
  };

  // Act
  const scope = effectiveMemoryScope('public', axes, { mode: 'enforce-strict' });

  // Assert — not even read-only.
  assert.deepStrictEqual(scope, ['ro:core', 'channel:teams~c1:*', 'team:teams~acme:*']);
  assert.ok(!scope.some((p) => p.includes('orchestrator:')));
});

test('enforce-strict with an unresolvable origin yields the agent-private scope and logs loudly', () => {
  // Arrange — under strict enforcement a context-free turn is an anomaly, so
  // it is audited. It is still answered, and still answered narrowly.
  const { lines, log } = sink();

  // Act
  const scope = effectiveMemoryScope('public', contextFreeAxes(), {
    mode: 'enforce-strict',
    log,
  });

  // Assert
  assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.msg, /\[security-audit\]/);
  assert.match(lines[0]!.msg, /no resolvable turn context/);
  assert.deepStrictEqual(lines[0]!.fields, {
    agentSlug: 'public',
    reason: 'context-free',
    mode: 'enforce-strict',
  });
});

test('enforce-strict names WHY the context was refused', () => {
  // Arrange — 'axes-missing' and 'no-usable-context-pattern' are different
  // bugs in different places; collapsing them would make the audit line
  // useless for finding the producer at fault.
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [undefined, 'axes-missing'],
    [null, 'axes-missing'],
    [{ isContextFree: true, patterns: [] }, 'context-free'],
    [{ isContextFree: false, patterns: ['core'] }, 'no-usable-context-pattern'],
  ];

  for (const [axes, reason] of cases) {
    const { lines, log } = sink();

    // Act
    effectiveMemoryScope('public', axes as MemoryAxes, { mode: 'enforce-strict', log });

    // Assert
    const audit = lines.filter((l) => l.msg.includes('[security-audit]'));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.fields?.reason, reason);
  }
});

test('the default mode does not audit context-free turns', () => {
  // Arrange — operator UI and CLI turns are legitimately context-free; logging
  // each one at security-audit level would bury the strict-mode signal.
  const { lines, log } = sink();

  // Act
  effectiveMemoryScope('public', contextFreeAxes(), { log });

  // Assert
  assert.deepStrictEqual(lines, []);
});

test('the default mode DOES audit a broken axes object', () => {
  // `context-free` is a legitimate turn shape and stays quiet above. These two
  // are not: they only happen when a channel plugin emits a broken axes object,
  // and the audit line is the only signal an operator gets that context memory
  // silently stopped working for that plugin. Suppressing them outside strict
  // mode — the mode production does NOT run — made the JSDoc's promise false
  // and left the failure invisible.
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [undefined, 'axes-missing'],
    [null, 'axes-missing'],
    [{ isContextFree: 'no', patterns: ['channel:teams~c1:*'] }, 'context-free'],
    [{ isContextFree: false, patterns: [] }, 'no-usable-context-pattern'],
    [{ isContextFree: false, patterns: ['core'] }, 'no-usable-context-pattern'],
  ];

  for (const [axes, reason] of cases) {
    const { lines, log } = sink();

    const scope = effectiveMemoryScope('public', axes as MemoryAxes, { log });

    // Fail-closed either way — the fix is diagnosability, not the scope.
    assert.deepStrictEqual(scope, orchestratorMemoryScope('public'));

    const audit = lines.filter((l) => l.msg.includes('[security-audit]'));
    if (reason === 'context-free') {
      // A wrong-typed flag is read as context-free by design (deny-default),
      // and the default mode stays quiet about context-free turns.
      assert.deepStrictEqual(audit, []);
      continue;
    }
    assert.equal(audit.length, 1, `expected one audit line for ${reason}`);
    assert.equal(audit[0]!.fields?.reason, reason);
    assert.equal(audit[0]!.fields?.mode, 'enforce');
  }
});

test('effectiveMemoryScope is pure — it never mutates the axes it is given', () => {
  // Arrange
  const patterns = ['channel:teams~c1:*', 'core', 'channel:teams~c1:*'];
  const axes: MemoryAxes = { isContextFree: false, patterns };

  // Act
  effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(patterns, ['channel:teams~c1:*', 'core', 'channel:teams~c1:*']);
  assert.deepStrictEqual(axes, { isContextFree: false, patterns });
});

test('a frozen axes object is accepted (memoryAxesForOrigin freezes its result)', () => {
  // Arrange — the SDK-side producer returns frozen axes; touching them would
  // throw in strict mode, which ESM always is.
  const axes = Object.freeze({
    isContextFree: false,
    patterns: Object.freeze(['channel:teams~c1:*']) as readonly string[],
  }) as MemoryAxes;

  // Act
  const scope = effectiveMemoryScope('public', axes);

  // Assert
  assert.deepStrictEqual(scope, [
    'ro:core',
    'ro:orchestrator:public:*',
    'channel:teams~c1:*',
  ]);
});
