import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryInvalidPathError } from '@omadia/memory';
import { PostgresMemoryStore } from '@omadia/memory-postgres';
import type { Pool } from 'pg';

/**
 * W6-1 follow-through — coverage for `PostgresMemoryStore`'s NUL-byte guard.
 *
 * The guard existed but was provably untested: disabling it entirely left the
 * whole middleware suite green. Its only coverage was
 * `memoryStoreConformance.pg.test.ts`, which skips without a Postgres and
 * asserts nothing about NUL anyway — and CI has no Postgres service on the
 * middleware job, so that suite never runs there at all.
 *
 * These tests need no Postgres by construction. `normalize()` runs before any
 * query, so a pool that THROWS when queried is the assertion: if validation
 * ever moved after the first query, the fake would fire and the test would fail
 * with the wrong error.
 */

/** A pool whose only behaviour is to fail loudly if anyone reaches it. */
function poolThatMustNotBeQueried(): Pool {
  return {
    query() {
      throw new Error('the store queried the database before validating the path');
    },
    connect() {
      throw new Error('the store took a client before validating the path');
    },
  } as unknown as Pool;
}

describe('PostgresMemoryStore path validation', () => {
  it('rejects a path containing a NUL byte, before touching the pool', async () => {
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());

    await assert.rejects(
      () => store.fileExists('/memories/core/no\0tes.md'),
      (err: unknown) => {
        assert.ok(
          err instanceof MemoryInvalidPathError,
          `expected MemoryInvalidPathError, got ${String(err)}`,
        );
        return true;
      },
    );
  });

  it('names the NUL byte in the error, rather than reporting a space', async () => {
    // The message read 'Path contains a space.' until W6-1 — almost certainly
    // because the raw 0x00 in the source was invisible to whoever wrote it.
    // An error that misnames the input it rejected sends the reader looking for
    // a bug that is not there.
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());

    await assert.rejects(
      () => store.fileExists('/memories/core/no\0tes.md'),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /NUL/i, `error should name the NUL byte, got: ${message}`);
        assert.doesNotMatch(
          message,
          /space/i,
          `error must not blame a space for a NUL byte, got: ${message}`,
        );
        return true;
      },
    );
  });

  it('applies the guard on every entry point, not just one', async () => {
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());
    const bad = '/memories/core/no\0tes.md';

    // ALL EIGHT path-taking methods, not a sample. An earlier version of this
    // test covered four and still called itself "every entry point"; a refactor
    // that added an early return to `delete` — bypassing normalize on the most
    // destructive method — would have passed it.
    await assert.rejects(() => store.list(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.fileExists(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.directoryExists(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.readFile(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.createFile(bad, 'x'), MemoryInvalidPathError);
    await assert.rejects(() => store.writeFile(bad, 'x'), MemoryInvalidPathError);
    await assert.rejects(() => store.delete(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.rename(bad, '/memories/core/ok.md'), MemoryInvalidPathError);
  });

  it("normalises rename's DESTINATION, not only its source", async () => {
    // `rename` is the one method taking two paths, and the second was entirely
    // unpinned: a refactor keeping `normalize(from)` and dropping `normalize(to)`
    // passed the whole suite. Defence in depth rather than an injection hole —
    // pg parameterisation rejects a NUL in a bind parameter at the driver — but
    // the guard should not depend on the driver to hold.
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());

    await assert.rejects(
      () => store.rename('/memories/core/from.md', '/memories/core/no\0tes.md'),
      MemoryInvalidPathError,
    );
  });

  it('accepts ordinary paths far enough to reach the pool', async () => {
    // The negative control, and it has to be wider than one tidy path.
    //
    // The bug this file exists for was a NUL branch reporting 'Path contains a
    // space.' Someone reading that message in a stale checkout "fixes" it the
    // other way round and adds a real space rejection. With a single
    // space-free control path, every test above stays green while every memory
    // file whose name contains a space breaks at runtime — the suite built to
    // protect this line would say nothing.
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());

    for (const clean of [
      '/memories/core/notes.md',
      '/memories/core/my notes.md', // a space is legal, and must stay legal
      '/memories/core/notes.v2.md', // a dot that is not a traversal
      '/memories/core/Ünïcödé.md',
    ]) {
      await assert.rejects(
        () => store.fileExists(clean),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          assert.match(
            message,
            /before validating the path/,
            `${clean} must survive validation and reach the pool, got: ${message}`,
          );
          return true;
        },
      );
    }
  });
});
