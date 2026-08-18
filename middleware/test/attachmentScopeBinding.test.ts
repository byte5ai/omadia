/**
 * #575 — a handle only redeems in the room that minted it.
 *
 * Guard 3 already refused a room that may not read attachments at all. What it
 * could not stop was the case its own header named: a storage key issued in a
 * private chat is a string, and a string can be pasted into a group chat that
 * happens to hold `attachment:read`. These tests pin that second check.
 *
 * The interesting cases are the ones where a wrong answer is INVISIBLE:
 *
 *  - a non-addressable scope (`'http-default'`, `teams-unknown`) must disable
 *    the check rather than approximate it — binding to one of those would
 *    declare every unrelated caller to be the same room, and it would read as
 *    enforcement while granting everyone access to everything;
 *  - a binding store that throws must REFUSE, not report "unbound", because
 *    "unbound" is exactly what the ordinary first-sighting looks like;
 *  - the first sighting must WIN, or a wider room could re-bind a handle to
 *    itself and then read it — the leak, reintroduced through the fix.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { audienceGuardedAttachmentReader } from '../packages/harness-orchestrator/src/attachmentReaderFactory.js';
import {
  bindingForRawScope,
  bindingsEqual,
  type AttachmentBindingStore,
  type AttachmentScopeBinding,
} from '../packages/harness-orchestrator/src/attachmentBinding.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { AttachmentReader } from '../packages/harness-orchestrator/src/tools/readAttachmentTool.js';

/** A reader that records whether the inner byte source was reached at all. */
function spyReader(): { reader: AttachmentReader; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async readByStorageKey(key) {
        reads.push(key);
        return { bytes: Buffer.from('payload') };
      },
      async readByUrl(url) {
        reads.push(url);
        return { bytes: Buffer.from('payload') };
      },
    },
  };
}

/** An in-memory binding store with first-sighting-wins semantics. */
function memoryBindings(seed?: Record<string, AttachmentScopeBinding>): AttachmentBindingStore {
  const rows = new Map<string, AttachmentScopeBinding>(Object.entries(seed ?? {}));
  return {
    async get(key) {
      return rows.get(key);
    },
    async bindIfAbsent(key, binding) {
      if (!rows.has(key)) rows.set(key, binding);
    },
  };
}

const failingBindings: AttachmentBindingStore = {
  async get() {
    throw new Error('connection terminated unexpectedly');
  },
  async bindIfAbsent() {
    throw new Error('connection terminated unexpectedly');
  },
};

/** Run `fn` inside a turn whose sessionScope is `scope`. */
async function inScope<T>(scope: string | undefined, fn: () => Promise<T>): Promise<T> {
  return turnContext.run(
    { turnId: 't1', turnDate: '2026-08-18', ...(scope ? { sessionScope: scope } : {}) },
    fn,
  );
}

describe('#575 handle binding — the room that minted it', () => {
  it('binds on first sighting and lets the same room read again', async () => {
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    await inScope('teams::conv-A', () => reader.readByStorageKey('att/1'));
    await inScope('teams::conv-A', () => reader.readByStorageKey('att/1'));

    assert.deepEqual(spy.reads, ['att/1', 'att/1']);
    assert.deepEqual(await bindings.get('att/1'), {
      scopeKind: 'conversation',
      scopeRef: 'teams::conv-A',
    });
  });

  it('refuses the same handle in a different room', async () => {
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(spy.reader, memoryBindings());

    await inScope('teams::conv-A', () => reader.readByStorageKey('att/1'));
    const leaked = await inScope('teams::conv-B', () => reader.readByStorageKey('att/1'));

    assert.equal(leaked, undefined, 'a handle minted in conv-A must not redeem in conv-B');
    assert.deepEqual(spy.reads, ['att/1'], 'the inner byte source must never be reached');
  });

  it('does not let a second room re-bind the handle to itself', async () => {
    // The leak, reintroduced through the fix: if the write overwrote, the
    // refused room would own the binding and its NEXT read would succeed.
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    await inScope('teams::conv-A', () => reader.readByStorageKey('att/1'));
    await inScope('teams::conv-B', () => reader.readByStorageKey('att/1'));
    const secondAttempt = await inScope('teams::conv-B', () => reader.readByStorageKey('att/1'));

    assert.equal(secondAttempt, undefined);
    assert.equal((await bindings.get('att/1'))?.scopeRef, 'teams::conv-A');
  });

  it('compares kind as well as reference', async () => {
    // `formatSessionScope` renders a personal scope as `personal:<id>` and a
    // conversation scope as its bare conversation id — which could itself be
    // that same string. Comparing references alone would make two different
    // kinds of room look like one.
    //
    // Asserted on `bindingsEqual` directly rather than through a raw scope
    // string, because `parseSessionScope` classifies `personal:u1` as personal:
    // the collision is not reachable from today's producers, so the kind check
    // is defensive. Pinning it here says so honestly instead of dressing an
    // unreachable case up as an end-to-end test.
    assert.equal(
      bindingsEqual(
        { scopeKind: 'personal', scopeRef: 'personal:u1' },
        { scopeKind: 'conversation', scopeRef: 'personal:u1' },
      ),
      false,
    );
    assert.equal(bindingForRawScope('personal:u1')?.scopeKind, 'personal');
  });
});

describe('#575 handle binding — where it deliberately stands down', () => {
  it('does not bind a shared, non-addressable scope', async () => {
    // `http-default` is shared by every unscoped HTTP caller — the live
    // cross-user hole in #445. Binding to it would declare all of them one
    // room: enforcement in appearance, universal access in fact.
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    const first = await inScope('http-default', () => reader.readByStorageKey('att/3'));
    const second = await inScope('http-default', () => reader.readByStorageKey('att/3'));

    assert.ok(first);
    assert.ok(second);
    assert.equal(await bindings.get('att/3'), undefined, 'nothing may be written for a shared scope');
  });

  it('does not bind when there is no scope at all', async () => {
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    assert.ok(await inScope(undefined, () => reader.readByStorageKey('att/4')));
    assert.equal(await bindings.get('att/4'), undefined);
  });

  it('is inert without a binding store', async () => {
    // A deployment that has not opted in must behave exactly as before.
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(spy.reader);

    assert.ok(await inScope('teams::conv-A', () => reader.readByStorageKey('att/5')));
    assert.ok(await inScope('teams::conv-B', () => reader.readByStorageKey('att/5')));
    assert.deepEqual(spy.reads, ['att/5', 'att/5']);
  });

  it('leaves readByUrl alone — a URL is not a storage key', async () => {
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(
      spy.reader,
      memoryBindings({ 'https://x/y': { scopeKind: 'conversation', scopeRef: 'other' } }),
    );
    assert.ok(await inScope('teams::conv-A', () => reader.readByUrl('https://x/y')));
  });
});

describe('#575 handle binding — an unreadable store refuses rather than unbinds', () => {
  it('refuses when the binding store throws', async () => {
    // "No binding" is what an ordinary first sighting looks like, so reporting
    // it on an outage would silently unbind every handle in the deployment.
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(spy.reader, failingBindings);

    const result = await inScope('teams::conv-A', () => reader.readByStorageKey('att/6'));
    assert.equal(result, undefined);
    assert.deepEqual(spy.reads, [], 'the inner byte source must never be reached');
  });
});
