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

    // Each of these normalises before its first query. A future refactor that
    // validates in only one of them is the failure this pins.
    await assert.rejects(() => store.list(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.fileExists(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.readFile(bad), MemoryInvalidPathError);
    await assert.rejects(() => store.writeFile(bad, 'x'), MemoryInvalidPathError);
  });

  it('accepts an ordinary path far enough to reach the pool', async () => {
    // The negative control. Without it, a `normalize` that rejected EVERY path
    // would satisfy all three tests above.
    const store = new PostgresMemoryStore(poolThatMustNotBeQueried());

    await assert.rejects(
      () => store.fileExists('/memories/core/notes.md'),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(
          message,
          /before validating the path/,
          `a clean path must survive validation and reach the pool, got: ${message}`,
        );
        return true;
      },
    );
  });
});
