/**
 * #575 / #1960 — a handle only redeems in the room that minted it, and only a
 * channel adapter's statement of an upload mints (ADR-0178).
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

/** Mint `key` in `scope` the way the ingest does for an adapter-stated upload. */
async function mint(reader: AttachmentReader, scope: string, key: string): Promise<void> {
  await inScope(scope, async () => {
    await reader.bindToCurrentConversation?.(key);
  });
}

describe('#575/#1960 handle binding — the room that minted it', () => {
  it('reads a handle the adapter stated in this room, again and again', async () => {
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    await mint(reader, 'teams::conv-A', 'att/1');
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

    await mint(reader, 'teams::conv-A', 'att/1');
    const leaked = await inScope('teams::conv-B', () => reader.readByStorageKey('att/1'));

    assert.equal(leaked, undefined, 'a handle minted in conv-A must not redeem in conv-B');
    assert.deepEqual(spy.reads, [], 'the inner byte source must never be reached');
  });

  it('#1960: a read never binds — an unbound key (an Office report, a diagram) is refused', async () => {
    // Before #1960 the first reader bound an unbound key to itself, so the
    // first chat that learned a generated file's key from a download link
    // claimed it.
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    const first = await inScope('teams::conv-B', () =>
      reader.readByStorageKey('documents/default/abc/report.docx'),
    );
    assert.equal(first, undefined);
    assert.equal(await bindings.get('documents/default/abc/report.docx'), undefined, 'nothing bound');
    assert.deepEqual(spy.reads, []);
  });

  it('does not let a second room re-mint the handle for itself', async () => {
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    await mint(reader, 'teams::conv-A', 'att/1');
    await mint(reader, 'teams::conv-B', 'att/1');
    const attempt = await inScope('teams::conv-B', () => reader.readByStorageKey('att/1'));

    assert.equal(attempt, undefined);
    assert.equal((await bindings.get('att/1'))?.scopeRef, 'teams::conv-A');
  });

  it('compares kind as well as reference', async () => {
    // `formatSessionScope` renders a personal scope as `personal:<id>` and a
    // conversation scope as its bare conversation id — which could itself be
    // that same string. Comparing references alone would make two different
    // kinds of room look like one. The collision is not reachable from
    // today's producers, so the kind check is defensive.
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

describe('#1960 handle binding — rooms that hold no bindings read nothing', () => {
  it('a shared, non-addressable scope neither mints nor reads', async () => {
    // `http-default` is shared by every unscoped HTTP caller (#445). Binding
    // to it would declare all of them one room; reading from it without a
    // binding would be the old stand-down. Both are refused.
    const spy = spyReader();
    const bindings = memoryBindings();
    const reader = audienceGuardedAttachmentReader(spy.reader, bindings);

    await mint(reader, 'http-default', 'att/3');
    const read = await inScope('http-default', () => reader.readByStorageKey('att/3'));

    assert.equal(read, undefined);
    assert.equal(await bindings.get('att/3'), undefined, 'nothing may be written for a shared scope');
    assert.deepEqual(spy.reads, []);
  });

  it('refuses a turn with no scope at all', async () => {
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(spy.reader, memoryBindings());
    assert.equal(await inScope(undefined, () => reader.readByStorageKey('att/4')), undefined);
  });

  it('is inert without a binding store (bare reader, no kernel store)', async () => {
    const spy = spyReader();
    const reader = audienceGuardedAttachmentReader(spy.reader);

    assert.equal(reader.bindToCurrentConversation, undefined);
    assert.ok(await inScope('teams::conv-A', () => reader.readByStorageKey('att/5')));
    assert.deepEqual(spy.reads, ['att/5']);
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
