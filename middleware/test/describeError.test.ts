import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { describeError } from '../src/platform/describeError.js';

// #1704 — `describeError` is the whole diagnosis for an outbound failure: undici
// reports every transport error as a bare "fetch failed" and keeps the reason in
// `err.cause`. Its callers (`registryClient.ts` since #1482, Conductor's webhook
// dispatcher and retry worker) only ever construct ONE level of cause, so the
// chain walk this module added is asserted here rather than through them.

describe('describeError', () => {
  it('returns the plain message when there is no cause', () => {
    assert.equal(describeError(new Error('plain')), 'plain');
  });

  it('stringifies a thrown non-Error', () => {
    assert.equal(describeError('just a string'), 'just a string');
    assert.equal(describeError(42), '42');
    assert.equal(describeError(null), 'null');
  });

  it('appends an Error cause (the #1482 behaviour, unchanged)', () => {
    assert.equal(
      describeError(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })),
      'fetch failed (unexpected redirect)',
    );
  });

  it('prefixes the system-error code when the message does not already name it', () => {
    assert.equal(
      describeError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      'fetch failed (ENOTFOUND)',
    );
    assert.equal(
      describeError(
        new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }),
      ),
      'fetch failed (ECONNRESET: socket hang up)',
    );
  });

  it('does not repeat a code the cause message already spells out', () => {
    // The real undici shape: `code` duplicates what the message already says.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND doesnotexist.invalid'), { code: 'ENOTFOUND' });
    assert.equal(
      describeError(new TypeError('fetch failed', { cause })),
      'fetch failed (getaddrinfo ENOTFOUND doesnotexist.invalid)',
    );
  });

  it('accepts a string cause', () => {
    assert.equal(describeError(new Error('outer', { cause: 'inner detail' })), 'outer (inner detail)');
  });

  it('walks a nested cause chain, newest first', () => {
    const deep = new Error('write EPROTO', { cause: undefined });
    const mid = new Error('client network socket disconnected', { cause: deep });
    assert.equal(
      describeError(new TypeError('fetch failed', { cause: mid })),
      'fetch failed (client network socket disconnected <- write EPROTO)',
    );
  });

  it('stops after three levels of cause', () => {
    const l4 = new Error('four');
    const l3 = new Error('three', { cause: l4 });
    const l2 = new Error('two', { cause: l3 });
    const described = describeError(new Error('one', { cause: l2 }));

    assert.equal(described, 'one (two <- three <- four)');
    // A fifth level is beyond the bound and must not appear.
    const l5 = new Error('five');
    (l4 as { cause?: unknown }).cause = l5;
    assert.doesNotMatch(describeError(new Error('one', { cause: l2 })), /five/);
  });

  it('skips a cause that only repeats the outer message', () => {
    // undici re-wraps the same sentence at more than one level for some failures;
    // repeating it would read as two separate problems.
    const inner = new Error('fetch failed');
    assert.equal(describeError(new TypeError('fetch failed', { cause: inner })), 'fetch failed');

    const dup = new Error('same');
    const outer = new Error('top', { cause: new Error('same', { cause: dup }) });
    assert.equal(describeError(outer), 'top (same)');
  });

  it('terminates on a self-referential cause instead of looping', () => {
    const err = new Error('loops');
    (err as { cause?: unknown }).cause = err;
    assert.equal(describeError(err), 'loops'); // its own message, deduped away
  });

  it('ignores a cause carrying neither a message nor a code', () => {
    assert.equal(describeError(new Error('bare', { cause: {} })), 'bare');
    assert.equal(describeError(new Error('bare', { cause: { errno: -3008 } })), 'bare');
  });
});
