import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DIRECT_LINE_EXIT_TOKENS,
  InMemoryDirectLineStickyStore,
  SHARED_SCOPES,
  STICKY_IDLE_TTL_MS,
  STICKY_MAX_BINDINGS,
  SYNTHETIC_SCOPE_PREFIXES,
  classifyStickyScope,
  decideDirectLineTurn,
  isDirectLineExitMessage,
  stickyKeyFor,
  type DirectLineBinding,
  type DirectLineCandidate,
  type StickyScopeClassification,
} from '@omadia/orchestrator';

// #445 — sticky Direct Line. Pure decision layer: no Orchestrator, no I/O.
// Everything here is a single binary probe on the target-SELECTION rules; the
// dispatch body is #332's and is asserted in directLine.test.ts.

const STRATEGIST: DirectLineCandidate = {
  toolName: 'ask_strategist',
  agentId: 'de.byte5.agent.strategist',
  label: 'Strategist',
};
const ANALYST: DirectLineCandidate = {
  toolName: 'ask_analyst',
  agentId: 'de.byte5.agent.analyst',
  label: 'Analyst',
};
const CANDIDATES: readonly DirectLineCandidate[] = [STRATEGIST, ANALYST];

const ELIGIBLE: StickyScopeClassification = { kind: 'eligible', key: 'k' };

function bindingFor(
  c: DirectLineCandidate,
  at = 1_000,
): DirectLineBinding {
  return {
    toolName: c.toolName,
    ...(c.agentId ? { agentId: c.agentId } : {}),
    label: c.label,
    boundAt: at,
    lastTurnAt: at,
  };
}

function decide(over: {
  userMessage: string;
  binding?: DirectLineBinding | undefined;
  stickyEnabled?: boolean;
  scope?: StickyScopeClassification;
  candidates?: readonly DirectLineCandidate[];
}) {
  return decideDirectLineTurn({
    userMessage: over.userMessage,
    prefix: '#',
    candidates: over.candidates ?? CANDIDATES,
    binding: over.binding,
    stickyEnabled: over.stickyEnabled ?? true,
    scope: over.scope ?? ELIGIBLE,
  });
}

// ── classifyStickyScope ──────────────────────────────────────────────────────

describe('#445 classifyStickyScope', () => {
  it('refuses when there is no sessionScope at all (cliSubAgent passes none)', () => {
    const r = classifyStickyScope({ agentSlug: 'default', userId: 'u1' });
    assert.deepEqual(r, { kind: 'refused', reason: 'no-scope' });
  });

  it('refuses an empty-string sessionScope', () => {
    const r = classifyStickyScope({ agentSlug: 'default', sessionScope: '   ' });
    assert.deepEqual(r, { kind: 'refused', reason: 'no-scope' });
  });

  it('refuses every synthetic scope prefix REGARDLESS of userId', () => {
    for (const scope of [
      'routine:daily-digest',
      'schedule:7',
      'conductor:run-1:step-2',
      'conductor-builder:slug:uuid',
    ]) {
      assert.deepEqual(
        classifyStickyScope({ agentSlug: 'a', sessionScope: scope, userId: 'u1' }),
        { kind: 'refused', reason: 'synthetic-scope' },
        `expected ${scope} refused even with a userId`,
      );
      assert.deepEqual(
        classifyStickyScope({ agentSlug: 'a', sessionScope: scope }),
        { kind: 'refused', reason: 'synthetic-scope' },
      );
    }
  });

  it('refuses a shared scope when no userId disambiguates it', () => {
    for (const scope of ['http-default', 'teams-unknown', 'unknown']) {
      assert.deepEqual(
        classifyStickyScope({ agentSlug: 'a', sessionScope: scope }),
        { kind: 'refused', reason: 'shared-scope' },
        `expected ${scope} refused without a userId`,
      );
    }
  });

  it('allows a shared scope once a userId makes the key per-person', () => {
    for (const scope of ['http-default', 'teams-unknown', 'unknown']) {
      const r = classifyStickyScope({ agentSlug: 'a', sessionScope: scope, userId: 'u1' });
      assert.equal(r.kind, 'eligible', `expected ${scope}+userId eligible`);
    }
  });

  it('allows a normal per-session scope even without a userId', () => {
    const r = classifyStickyScope({
      agentSlug: 'default',
      sessionScope: '6f1c2a7e-0f2a-4d1b-9a3e-2b1d4c5e6f70',
    });
    assert.equal(r.kind, 'eligible');
  });

  it('exposes the gate constants it reasons over', () => {
    assert.ok(SHARED_SCOPES.has('http-default'));
    assert.ok(SYNTHETIC_SCOPE_PREFIXES.includes('routine:'));
    assert.ok(DIRECT_LINE_EXIT_TOKENS.has('end'));
    assert.ok(DIRECT_LINE_EXIT_TOKENS.has('orchestrator'));
  });
});

// ── stickyKeyFor ─────────────────────────────────────────────────────────────

describe('#445 stickyKeyFor', () => {
  it('is deterministic for identical inputs', () => {
    const a = { agentSlug: 'default', sessionScope: 's1', userId: 'u1' };
    assert.equal(stickyKeyFor(a), stickyKeyFor({ ...a }));
  });

  it('diverges on agentSlug, sessionScope and userId independently', () => {
    const base = { agentSlug: 'default', sessionScope: 's1', userId: 'u1' };
    const k = stickyKeyFor(base);
    assert.notEqual(k, stickyKeyFor({ ...base, agentSlug: 'other' }));
    assert.notEqual(k, stickyKeyFor({ ...base, sessionScope: 's2' }));
    assert.notEqual(k, stickyKeyFor({ ...base, userId: 'u2' }));
  });

  it('separates fields with NUL so no concatenation collision is possible', () => {
    const NUL = String.fromCharCode(0);
    assert.equal(
      stickyKeyFor({ agentSlug: 'a', sessionScope: 'b', userId: 'c' }),
      `a${NUL}b${NUL}c`,
    );
    // The classic ambiguity: ('a','b','c') vs ('a','b\0c') would collide under
    // a plain join. With NUL unavailable to real ids, these stay distinct.
    assert.notEqual(
      stickyKeyFor({ agentSlug: 'a', sessionScope: 'b', userId: 'c' }),
      stickyKeyFor({ agentSlug: 'a', sessionScope: 'bc', userId: '' }),
    );
  });

  it('treats an absent userId as empty, not as the string "undefined"', () => {
    const k = stickyKeyFor({ agentSlug: 'a', sessionScope: 'b' });
    assert.ok(!k.includes('undefined'));
  });
});

// ── isDirectLineExitMessage ──────────────────────────────────────────────────

describe('#445 isDirectLineExitMessage', () => {
  it('matches the reserved exit tokens as a WHOLE message, case-insensitively', () => {
    assert.equal(isDirectLineExitMessage('#end', '#'), true);
    assert.equal(isDirectLineExitMessage('  #ORCHESTRATOR  ', '#'), true);
    assert.equal(isDirectLineExitMessage('#Orchestrator', '#'), true);
  });

  it('never fires on ordinary text that merely starts with the token', () => {
    for (const text of [
      '#end of quarter — what now?',
      'please #end',
      '#end.',
      '#ending',
      '#endorse this plan',
      '#e',
      'end',
    ]) {
      assert.equal(
        isDirectLineExitMessage(text, '#'),
        false,
        `expected NOT an exit: ${JSON.stringify(text)}`,
      );
    }
  });

  it('honours a non-default prefix', () => {
    assert.equal(isDirectLineExitMessage('!end', '!'), true);
    assert.equal(isDirectLineExitMessage('#end', '!'), false);
  });
});

// ── decideDirectLineTurn ─────────────────────────────────────────────────────

describe('#445 decideDirectLineTurn — flag OFF is byte-for-byte #332', () => {
  it('an unknown token still falls through to the LLM (collision rule)', () => {
    const d = decide({ userMessage: '#urgent server is down', stickyEnabled: false });
    assert.deepEqual(d, { kind: 'ordinary' });
  });

  it('a resolved directive with a payload dispatches, never sticky', () => {
    const d = decide({ userMessage: '#strategist risks?', stickyEnabled: false });
    assert.equal(d.kind, 'dispatch');
    assert.equal(d.kind === 'dispatch' && d.sticky, false);
    assert.equal(d.kind === 'dispatch' && d.payload, 'risks?');
  });

  it('a bare #agent is still the no-question notice, NOT an entry', () => {
    const d = decide({ userMessage: '#strategist', stickyEnabled: false });
    assert.equal(d.kind, 'notice');
    assert.equal(d.kind === 'notice' && d.reason, 'no-question');
  });

  it('an ordinary message is ordinary even when a stale binding exists', () => {
    const d = decide({
      userMessage: 'what is the plan?',
      stickyEnabled: false,
      binding: bindingFor(STRATEGIST),
    });
    assert.deepEqual(d, { kind: 'ordinary' });
  });

  it('#end is not an exit when the feature is off', () => {
    const d = decide({
      userMessage: '#end',
      stickyEnabled: false,
      binding: bindingFor(STRATEGIST),
    });
    assert.deepEqual(d, { kind: 'ordinary' });
  });
});

describe('#445 decideDirectLineTurn — entry', () => {
  it('a bare #agent binds the conversation when the scope is eligible', () => {
    const d = decide({ userMessage: '#strategist' });
    assert.equal(d.kind, 'enter');
    assert.equal(d.kind === 'enter' && d.candidate.toolName, 'ask_strategist');
  });

  it('tolerates trailing whitespace on the entry gesture', () => {
    const d = decide({ userMessage: '  #Strategist   ' });
    assert.equal(d.kind, 'enter');
  });

  it('refuses to bind on an ineligible scope and names the reason', () => {
    const d = decide({
      userMessage: '#strategist',
      scope: { kind: 'refused', reason: 'shared-scope' },
    });
    assert.equal(d.kind, 'notice');
    assert.equal(d.kind === 'notice' && d.reason, 'sticky-refused');
    assert.equal(d.kind === 'notice' && d.refusedReason, 'shared-scope');
  });

  it('an unknown bare token is ordinary, not an entry (collision rule holds)', () => {
    const d = decide({ userMessage: '#urgent' });
    assert.deepEqual(d, { kind: 'ordinary' });
  });

  it('an ambiguous bare token disambiguates instead of binding', () => {
    const dupes: readonly DirectLineCandidate[] = [
      { toolName: 'ask_strategist', agentId: 'a.strategist', label: 'Strategist' },
      { toolName: 'consult_strategist', agentId: 'b.strategist', label: 'Strategist' },
    ];
    const d = decide({ userMessage: '#strategist', candidates: dupes });
    assert.equal(d.kind, 'notice');
    assert.equal(d.kind === 'notice' && d.reason, 'ambiguous');
    assert.equal(d.kind === 'notice' && d.matches?.length, 2);
  });
});

describe('#445 decideDirectLineTurn — while bound', () => {
  const bound = bindingFor(STRATEGIST);

  it('routes a plain message to the bound specialist verbatim', () => {
    const d = decide({ userMessage: 'and the second risk?', binding: bound });
    assert.equal(d.kind, 'dispatch');
    assert.equal(d.kind === 'dispatch' && d.sticky, true);
    assert.equal(d.kind === 'dispatch' && d.payload, 'and the second risk?');
    assert.equal(d.kind === 'dispatch' && d.candidate.toolName, 'ask_strategist');
  });

  it('preserves the message byte-for-byte, including leading # of an unknown token', () => {
    const d = decide({ userMessage: '#urgent server is down', binding: bound });
    assert.equal(d.kind, 'dispatch');
    assert.equal(d.kind === 'dispatch' && d.payload, '#urgent server is down');
    assert.equal(d.kind === 'dispatch' && d.sticky, true);
  });

  it('preserves whitespace-significant payloads (fenced code)', () => {
    const msg = '```ts\n  const x = 1;\n```';
    const d = decide({ userMessage: msg, binding: bound });
    assert.equal(d.kind === 'dispatch' && d.payload, msg);
  });

  it('a one-shot #other directive does NOT rebind — per-message stays per-message', () => {
    const d = decide({ userMessage: '#analyst crunch these numbers', binding: bound });
    assert.equal(d.kind, 'dispatch');
    assert.equal(d.kind === 'dispatch' && d.candidate.toolName, 'ask_analyst');
    assert.equal(
      d.kind === 'dispatch' && d.sticky,
      false,
      'a one-shot directive must not carry sticky:true',
    );
  });

  it('exits on the reserved token', () => {
    assert.deepEqual(decide({ userMessage: '#end', binding: bound }), { kind: 'exit' });
    assert.deepEqual(decide({ userMessage: '#orchestrator', binding: bound }), {
      kind: 'exit',
    });
  });

  it('does NOT exit on prose that merely begins with the exit token', () => {
    const d = decide({ userMessage: '#end of quarter — what now?', binding: bound });
    assert.equal(d.kind, 'dispatch');
    assert.equal(d.kind === 'dispatch' && d.payload, '#end of quarter — what now?');
  });

  it('a bare #agent for the ALREADY bound specialist is a no-op notice, not a rebind', () => {
    const d = decide({ userMessage: '#strategist', binding: bound });
    assert.equal(d.kind, 'notice');
    assert.equal(d.kind === 'notice' && d.reason, 'already-bound');
  });

  it('a bare #other rebinds to the new specialist', () => {
    const d = decide({ userMessage: '#analyst', binding: bound });
    assert.equal(d.kind, 'enter');
    assert.equal(d.kind === 'enter' && d.candidate.toolName, 'ask_analyst');
  });

  it('an exit token that RESOLVES to a real specialist is not an exit', () => {
    const shadowed: readonly DirectLineCandidate[] = [
      { toolName: 'ask_end', agentId: 'x.end', label: 'End' },
    ];
    const d = decide({
      userMessage: '#end',
      binding: bindingFor(shadowed[0]!),
      candidates: shadowed,
    });
    assert.notEqual(d.kind, 'exit');
  });
});

// ── InMemoryDirectLineStickyStore ────────────────────────────────────────────

describe('#445 InMemoryDirectLineStickyStore', () => {
  it('binds and reads back an immutable binding', () => {
    let now = 1_000;
    const store = new InMemoryDirectLineStickyStore({ now: () => now });
    const b = store.bind('k1', {
      toolName: 'ask_strategist',
      agentId: 'a.strategist',
      label: 'Strategist',
    });
    assert.equal(b.toolName, 'ask_strategist');
    assert.equal(b.boundAt, 1_000);
    const read = store.get('k1');
    assert.deepEqual(read, b);
    assert.equal(store.size(), 1);
  });

  it('never mutates a stored binding in place on touch', () => {
    let now = 1_000;
    const store = new InMemoryDirectLineStickyStore({ now: () => now });
    const first = store.bind('k1', { toolName: 't', label: 'T' });
    now = 5_000;
    store.touch('k1');
    const after = store.get('k1');
    assert.equal(first.lastTurnAt, 1_000, 'the original object must be untouched');
    assert.equal(after?.lastTurnAt, 5_000);
    assert.equal(after?.boundAt, 1_000, 'boundAt is stable across touches');
  });

  it('expires a binding after the idle TTL', () => {
    let now = 0;
    const store = new InMemoryDirectLineStickyStore({ now: () => now });
    store.bind('k1', { toolName: 't', label: 'T' });
    now = STICKY_IDLE_TTL_MS - 1;
    assert.ok(store.get('k1'), 'still live just before the TTL');
    now = STICKY_IDLE_TTL_MS + 1;
    assert.equal(store.get('k1'), undefined, 'expired after the TTL');
    assert.equal(store.size(), 0, 'expiry evicts, it does not just hide');
  });

  it('touch slides the idle window', () => {
    let now = 0;
    const store = new InMemoryDirectLineStickyStore({ now: () => now });
    store.bind('k1', { toolName: 't', label: 'T' });
    now = STICKY_IDLE_TTL_MS - 10;
    store.touch('k1');
    now = STICKY_IDLE_TTL_MS + 10;
    assert.ok(store.get('k1'), 'the touch reset the idle clock');
  });

  it('clear() removes a binding', () => {
    const store = new InMemoryDirectLineStickyStore();
    store.bind('k1', { toolName: 't', label: 'T' });
    store.clear('k1');
    assert.equal(store.get('k1'), undefined);
    assert.equal(store.size(), 0);
  });

  it('clear() on an absent key is a silent no-op', () => {
    const store = new InMemoryDirectLineStickyStore();
    store.clear('nope');
    assert.equal(store.size(), 0);
  });

  it('evicts least-recently-used entries at the cap', () => {
    const store = new InMemoryDirectLineStickyStore({ maxEntries: 3 });
    store.bind('a', { toolName: 't', label: 'T' });
    store.bind('b', { toolName: 't', label: 'T' });
    store.bind('c', { toolName: 't', label: 'T' });
    store.get('a'); // 'a' becomes most-recently-used, so 'b' is now the LRU
    store.bind('d', { toolName: 't', label: 'T' });
    assert.equal(store.size(), 3);
    assert.equal(store.get('b'), undefined, 'b was the least recently used');
    assert.ok(store.get('a'));
    assert.ok(store.get('c'));
    assert.ok(store.get('d'));
  });

  it('defaults are the documented production values', () => {
    assert.equal(STICKY_IDLE_TTL_MS, 2 * 60 * 60 * 1000);
    assert.equal(STICKY_MAX_BINDINGS, 1000);
  });

  it('keeps two userIds on ONE sessionScope isolated end-to-end', () => {
    const store = new InMemoryDirectLineStickyStore();
    const shared = 'teams-conversation-42';
    const kA = stickyKeyFor({ agentSlug: 'default', sessionScope: shared, userId: 'alice' });
    const kB = stickyKeyFor({ agentSlug: 'default', sessionScope: shared, userId: 'bob' });
    store.bind(kA, { toolName: 'ask_strategist', label: 'Strategist' });
    assert.equal(store.get(kB), undefined, "bob must not inherit alice's binding");
    store.bind(kB, { toolName: 'ask_analyst', label: 'Analyst' });
    assert.equal(store.get(kA)?.toolName, 'ask_strategist');
    assert.equal(store.get(kB)?.toolName, 'ask_analyst');
  });
});
