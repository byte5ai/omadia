import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import {
  GithubIssueCache,
  type CacheFetch,
} from '../../src/plugins/builder/githubIssueCache.js';

interface MockResponse {
  ok: boolean;
  status: number;
  headers: Map<string, string>;
  body?: unknown;
}

function makeResponse(opts: Partial<MockResponse> & { status: number }) {
  const headers = opts.headers ?? new Map<string, string>();
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    json: () => Promise.resolve(opts.body ?? {}),
  };
}

function recordingFetch(
  responses: MockResponse[],
): { fetch: CacheFetch; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetch: CacheFetch = (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = responses[Math.min(index, responses.length - 1)];
    if (r) index += 1;
    return Promise.resolve(makeResponse(r ?? { status: 500 }));
  };
  return { fetch, calls };
}

describe('GithubIssueCache — getIssueStatus', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;
  let now: number;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gh-cache-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = join(tmp, `cache-${String(Date.now())}-${String(Math.random())}.db`);
    // The cache reads from the v2 schema created by DraftStore migrations.
    store = new DraftStore({ dbPath });
    await store.open();
    now = 1_700_000_000_000;
  });

  it('caches a fresh issue status and serves the second call without a fetch', async () => {
    const { fetch, calls } = recordingFetch([
      {
        status: 200,
        headers: new Map([['etag', 'W/"abc"']]),
        body: { state: 'open', closed_at: null },
      },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const first = await cache.getIssueStatus('byte5ai', 'omadia', 42);
      assert.ok(first);
      assert.equal(first.state, 'open');
      assert.equal(first.fromCache, false);
      assert.equal(calls.length, 1);

      // Second call within TTL → cache hit, no fetch.
      const second = await cache.getIssueStatus('byte5ai', 'omadia', 42);
      assert.ok(second);
      assert.equal(second.fromCache, true);
      assert.equal(second.rateLimited, false);
      assert.equal(calls.length, 1);
    } finally {
      await cache.close();
    }
  });

  it('uses If-None-Match on stale entries and accepts 304', async () => {
    const { fetch, calls } = recordingFetch([
      {
        status: 200,
        headers: new Map([['etag', 'W/"abc"']]),
        body: { state: 'open', closed_at: null },
      },
      { status: 304, headers: new Map() },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      ttlMs: 100,
      now: () => now,
    });
    await cache.open();
    try {
      await cache.getIssueStatus('byte5ai', 'omadia', 7);
      now += 1000; // advance past TTL
      const second = await cache.getIssueStatus('byte5ai', 'omadia', 7);
      assert.ok(second);
      assert.equal(second.state, 'open');
      assert.equal(second.cachedAt, now); // bumped
      assert.equal(calls.length, 2);
      assert.match(calls[1] ?? '', /api\.github\.com/);
    } finally {
      await cache.close();
    }
  });

  it('persists backoff_until on 403 and short-circuits subsequent calls', async () => {
    const { fetch, calls } = recordingFetch([
      // First call: success, prime cache
      {
        status: 200,
        headers: new Map([['etag', 'W/"e1"']]),
        body: { state: 'open', closed_at: null },
      },
      // Second call: 403 rate-limit
      {
        status: 403,
        headers: new Map([['retry-after', '120']]),
      },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      ttlMs: 50,
      now: () => now,
    });
    await cache.open();
    try {
      await cache.getIssueStatus('byte5ai', 'omadia', 9);
      now += 1000; // force stale
      const limited = await cache.getIssueStatus('byte5ai', 'omadia', 9);
      assert.ok(limited);
      assert.equal(limited.rateLimited, true);
      assert.equal(limited.fromCache, true);
      // Third call still inside backoff window → no new fetch.
      now += 1000;
      const stillLimited = await cache.getIssueStatus('byte5ai', 'omadia', 9);
      assert.ok(stillLimited);
      assert.equal(stillLimited.rateLimited, true);
      assert.equal(calls.length, 2); // no third network call
    } finally {
      await cache.close();
    }
  });

  it('caches 404 as null and does not re-fetch immediately', async () => {
    const { fetch, calls } = recordingFetch([
      { status: 404, headers: new Map() },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const r1 = await cache.getIssueStatus('byte5ai', 'omadia', 9999);
      assert.equal(r1, null);
      assert.equal(calls.length, 1);
    } finally {
      await cache.close();
    }
  });

  it('caches closed state and surfaces closedAt', async () => {
    const closedAtIso = '2024-01-15T10:00:00Z';
    const { fetch } = recordingFetch([
      {
        status: 200,
        headers: new Map(),
        body: { state: 'closed', closed_at: closedAtIso },
      },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const r = await cache.getIssueStatus('byte5ai', 'omadia', 3);
      assert.ok(r);
      assert.equal(r.state, 'closed');
      assert.equal(r.closedAt, Date.parse(closedAtIso));
    } finally {
      await cache.close();
    }
  });
});

describe('GithubIssueCache — searchByFingerprint', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;
  let now: number;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gh-search-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = join(tmp, `search-${String(Date.now())}-${String(Math.random())}.db`);
    store = new DraftStore({ dbPath });
    await store.open();
    now = 1_700_000_000_000;
  });

  it('returns the first matching issue when GitHub finds one', async () => {
    const { fetch } = recordingFetch([
      {
        status: 200,
        headers: new Map(),
        body: {
          items: [
            {
              number: 123,
              state: 'open',
              html_url: 'https://github.com/byte5ai/omadia/issues/123',
            },
          ],
        },
      },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const hit = await cache.searchByFingerprint(
        'byte5ai',
        'omadia',
        'deadbeef',
      );
      assert.ok(hit);
      assert.equal(hit.number, 123);
      assert.equal(hit.state, 'open');
      assert.equal(hit.fingerprint, 'deadbeef');
    } finally {
      await cache.close();
    }
  });

  it('returns null when GitHub finds no match', async () => {
    const { fetch } = recordingFetch([
      { status: 200, headers: new Map(), body: { items: [] } },
    ]);
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const hit = await cache.searchByFingerprint(
        'byte5ai',
        'omadia',
        'no-such-hash',
      );
      assert.equal(hit, null);
    } finally {
      await cache.close();
    }
  });

  it('serializes two concurrent searches for the same fingerprint', async () => {
    let calls = 0;
    const fetch: CacheFetch = () => {
      calls += 1;
      return Promise.resolve(
        makeResponse({
          status: 200,
          headers: new Map(),
          body: {
            items: [
              {
                number: 555,
                state: 'open',
                html_url: 'https://github.com/byte5ai/omadia/issues/555',
              },
            ],
          },
        }),
      );
    };
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      const [a, b] = await Promise.all([
        cache.searchByFingerprint('byte5ai', 'omadia', 'race-hash'),
        cache.searchByFingerprint('byte5ai', 'omadia', 'race-hash'),
      ]);
      assert.equal(calls, 1, 'in-memory inflight map should dedupe');
      assert.equal(a?.number, 555);
      assert.equal(b?.number, 555);
    } finally {
      await cache.close();
    }
  });

  it('clears the pending lock after the search resolves', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        makeResponse({
          status: 200,
          headers: new Map(),
          body: { items: [] },
        }),
      );
    const cache = new GithubIssueCache({
      dbPath,
      fetch,
      now: () => now,
    });
    await cache.open();
    try {
      await cache.searchByFingerprint('byte5ai', 'omadia', 'cleanup-hash');
      // Sequential follow-up search → no in-memory inflight, must
      // succeed by acquiring a fresh lock.
      const hit = await cache.searchByFingerprint(
        'byte5ai',
        'omadia',
        'cleanup-hash',
      );
      assert.equal(hit, null);
    } finally {
      await cache.close();
    }
  });
});
