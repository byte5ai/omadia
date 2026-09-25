import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import {
  PostgresMemoryStore,
  descendantsLikePattern,
} from '../packages/harness-memory-postgres/src/postgresMemoryStore.js';

/**
 * #909 — `PostgresMemoryStore` finds a directory's descendants with
 * `virtual_path LIKE '<dir>/%'`. `%` and `_` are `LIKE` wildcards and `\` its
 * escape character, so an unescaped directory path is a PATTERN, not a prefix:
 * `/memories/a_b` also matches `/memories/a-b/...`. Plugin ids may contain `_`,
 * and `ctx.tools.invoke('memory')` exposes directory rename/delete, so that
 * sibling match would move or delete another plugin's memory.
 *
 * These tests need no Postgres. The end-to-end behaviour against a real
 * database is covered by the shared conformance suite
 * (`memoryStoreConformance.pg.test.ts`, run by `npm run test:pg`).
 */

describe('descendantsLikePattern', () => {
  it('leaves a plain path alone and appends the descendant wildcard', () => {
    assert.equal(
      descendantsLikePattern('/memories/orchestrators/default'),
      '/memories/orchestrators/default/%',
    );
  });

  it('escapes `_`, `%` and `\\` so the prefix is matched literally', () => {
    assert.equal(
      descendantsLikePattern('/memories/orchestrators/x/plugins/@omadi_/agent'),
      '/memories/orchestrators/x/plugins/@omadi\\_/agent/%',
    );
    assert.equal(descendantsLikePattern('/memories/a%b'), '/memories/a\\%b/%');
    assert.equal(descendantsLikePattern('/memories/a\\b'), '/memories/a\\\\b/%');
    assert.equal(
      descendantsLikePattern('/memories/_%\\'),
      '/memories/\\_\\%\\\\/%',
    );
  });
});

interface LikeCall {
  readonly sql: string;
  readonly pattern: unknown;
}

/**
 * A pool that records every `LIKE` query. A `LIKE` probe "hits" (rowCount 1)
 * unless it scans the rename target, so each method walks its directory
 * branch — the branch that carries the prefix scan.
 */
function recordingPool(renameTarget: string): { pool: Pool; likes: LikeCall[] } {
  const likes: LikeCall[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    if (!/\bLIKE\b/.test(sql)) return { rowCount: 0, rows: [] };
    const pattern = params[params.length - 1];
    likes.push({ sql, pattern });
    const hit = !String(pattern).startsWith(renameTarget);
    return { rowCount: hit ? 1 : 0, rows: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
  return { pool, likes };
}

describe('PostgresMemoryStore prefix scans', () => {
  it('escape the directory path and pin ESCAPE on every LIKE query', async () => {
    const dir = '/memories/a_b%c\\d';
    const target = '/memories/dest';
    const { pool, likes } = recordingPool(target);
    const store = new PostgresMemoryStore(pool);

    await store.directoryExists(dir);
    await store.list(dir);
    await store.delete(dir);
    await store.rename(dir, target);

    // directoryExists 1 + list 2 + delete 1 + rename (source probe, target
    // probe, UPDATE) 3 — one per prefix scan the store runs.
    assert.equal(likes.length, 7);
    for (const { sql, pattern } of likes) {
      assert.match(sql, /\bLIKE \$\d+ ESCAPE '\\'/, `unpinned escape: ${sql}`);
      assert.ok(
        pattern === descendantsLikePattern(dir) ||
          pattern === descendantsLikePattern(target),
        `unescaped LIKE pattern: ${String(pattern)}`,
      );
    }
    assert.ok(
      likes.some((l) => l.pattern === '/memories/a\\_b\\%c\\\\d/%'),
      'the source directory was never scanned with its escaped pattern',
    );
  });
});
